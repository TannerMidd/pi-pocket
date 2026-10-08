import contextlib
import json
import shlex
import time
from collections import abc
from typing import Literal, NotRequired, TypedDict, cast

from test_driver.machine import QemuMachine


class InstalledExtension(TypedDict):
    name: str
    tools: list[str]


class ExtensionModule(TypedDict):
    file: str
    enabled: bool
    source: Literal["built-in", "drop-in"]
    error: NotRequired[str]
    extensions: list[InstalledExtension]


class ExtensionsResponse(TypedDict):
    modules: list[ExtensionModule]


class Probe(TypedDict):
    pid: int
    version: Literal["v1", "v2"]


class UserRecord(TypedDict):
    name: str
    role: str


class HelloResponse(TypedDict):
    user: UserRecord


class ConfigRecord(TypedDict):
    ownerToken: str
    users: list[UserRecord]


class SessionRecord(TypedDict):
    id: int
    title: str


class CreatedSession(TypedDict):
    id: int


type RequestBody = dict[str, str | bool]
type Subtest = abc.Callable[[str], contextlib.AbstractContextManager[None]]
type Version = Literal["v1", "v2"]


def run_service_test(vm: QemuMachine, phase: Subtest) -> None:
    data = "/var/lib/pi-pocket"
    declared = data + "/extensions/extension.ts"
    owner_file = data + "/extensions/owner.ts"
    token = ""
    session_id = 0

    def as_user(command: str) -> str:
        return "runuser -u pi-pocket -- sh -c " + shlex.quote(command)

    def read_json(path: str) -> object:
        return cast(
            object, json.loads(vm.succeed(as_user("cat -- " + shlex.quote(path))))
        )

    def api_command(path: str, body: RequestBody | None = None) -> str:
        assert token
        command = [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            "-H",
            "Authorization: Bearer " + token,
            "-H",
            "X-Pocket: 1",
        ]
        if body is not None:
            command += [
                "-H",
                "Content-Type: application/json",
                "--data",
                json.dumps(body),
            ]
        command += ["http://127.0.0.1:8787/api/" + path]
        return " ".join(shlex.quote(part) for part in command)

    def api(path: str, body: RequestBody | None = None) -> object:
        return cast(object, json.loads(vm.succeed(as_user(api_command(path, body)))))

    def wait_json(path: str, condition: abc.Callable[[object], bool]) -> None:
        deadline = time.monotonic() + 90
        while True:
            status, output = vm.execute(as_user(api_command(path)))
            if status == 0 and condition(cast(object, json.loads(output))):
                return
            assert time.monotonic() < deadline, (
                f"Timed out waiting for /api/{path}: {output}"
            )
            time.sleep(1)

    def wait_extensions(condition: abc.Callable[[list[ExtensionModule]], bool]) -> None:
        wait_json(
            "extensions",
            lambda value: condition(cast(ExtensionsResponse, value)["modules"]),
        )

    def wait_loaded(file: str, version: Version, *, owner: bool = False) -> None:
        name = ("owner-runtime-" if owner else "runtime-") + version
        tool = ("owner_probe_" if owner else "probe_") + version
        expected: list[InstalledExtension] = [{"name": name, "tools": [tool]}]
        wait_extensions(
            lambda modules: any(
                module["file"] == file
                and module["enabled"]
                and not module.get("error")
                and module["extensions"] == expected
                for module in modules
            )
        )

    def main_pid() -> int:
        return int(vm.succeed("systemctl show pi-pocket.service -p MainPID --value"))

    def probe() -> Probe:
        return cast(Probe, read_json(data + "/runtime-probe.json"))

    def check_server(pid: int) -> None:
        # the marker is written by the extension factory, not the supervising launcher
        group = vm.succeed(
            "systemctl show pi-pocket.service -p ControlGroup --value"
        ).strip()
        vm.succeed(
            as_user(
                f"grep -F -- {shlex.quote(group)} /proc/{pid}/cgroup; "
                f"tr '\\0' '\\n' < /proc/{pid}/cmdline | grep -F -- /src/server/main.ts"
            )
        )
        assert pid != main_pid()

    def edit_declared() -> None:
        vm.succeed(as_user("sed -i 's/v1/v2/g' " + declared))
        wait_loaded("extension.ts", "v2")
        assert probe()["version"] == "v2"

    def create_owner() -> None:
        # separate names and marker avoid replacing the declared module's registration
        vm.succeed(
            as_user(
                "sed -e 's/v2/v1/g' -e 's/runtime-/owner-runtime-/g' "
                "-e 's/probe_/owner_probe_/g' " + declared + " > " + owner_file
            )
        )
        wait_extensions(
            lambda modules: any(module["file"] == "owner.ts" for module in modules)
        )
        api("extensions/owner.ts", {"enabled": True})
        wait_loaded("owner.ts", "v1", owner=True)

    def check_persistent_state() -> None:
        # keep using the original token: regenerating config must fail authentication
        wait_json(
            "me", lambda value: cast(HelloResponse, value)["user"]["name"] == "VM owner"
        )
        wait_json(
            "sessions",
            lambda value: any(
                session["id"] == session_id
                and session["title"] == "Installed runtime session"
                for session in cast(list[SessionRecord], value)
            ),
        )
        config = cast(ConfigRecord, read_json(data + "/config.json"))
        assert config["ownerToken"] == token
        assert any(
            user["role"] == "owner" and user["name"] == "VM owner"
            for user in config["users"]
        )

    def check_owner_removed() -> None:
        vm.succeed("test ! -e " + owner_file)
        wait_extensions(
            lambda modules: not any(module["file"] == "owner.ts" for module in modules)
        )

    try:
        vm.start()
        vm.wait_for_unit("pi-pocket.service")
        vm.wait_for_open_port(8787)
        base_system = vm.succeed("readlink -f /run/current-system").strip()
        vm.wait_until_succeeds("test -s " + data + "/config.json")
        token = vm.succeed(
            as_user("jq -er '.ownerToken' " + data + "/config.json")
        ).strip()
        wait_json(
            "me", lambda value: cast(HelloResponse, value)["user"]["role"] == "owner"
        )

        with phase(
            "service-owned writable copy, dependency link, and default-off module"
        ):
            vm.succeed(
                "test $(stat -c '%U:%G:%a' " + declared + ") = pi-pocket:pi-pocket:600"
            )
            vm.succeed("test ! -L " + declared)
            vm.succeed("cmp " + declared + " /etc/pi-pocket-test/v1.ts")
            vm.succeed("test -L " + data + "/extensions/node_modules")
            wait_extensions(
                lambda modules: any(
                    module["file"] == "extension.ts"
                    and not module["enabled"]
                    and not module.get("error")
                    and module["extensions"] == []
                    for module in modules
                )
            )
            vm.succeed("test ! -e " + data + "/runtime-probe.json")
            api("extensions/extension.ts", {"enabled": True})
            wait_loaded("extension.ts", "v1")
            launcher_pid = main_pid()
            server_pid = probe()["pid"]
            assert probe()["version"] == "v1"
            check_server(server_pid)

            api("me", {"name": "VM owner"})
            session_id = cast(
                CreatedSession, api("sessions", {"title": "Installed runtime session"})
            )["id"]
            check_persistent_state()

        with phase("live edit reloads tools without restarting either process"):
            edit_declared()
            assert probe()["pid"] == server_pid
            assert main_pid() == launcher_pid

        with phase("app restart preserves edited copy and launcher"):
            api("restart", {})
            vm.wait_until_succeeds(
                as_user(f"jq -e '.pid != {server_pid}' {data}/runtime-probe.json")
            )
            wait_loaded("extension.ts", "v2")
            assert probe()["version"] == "v2"
            assert main_pid() == launcher_pid
            check_server(probe()["pid"])
            check_persistent_state()

        with phase("owner-created extension enables and hot reloads"):
            create_owner()
            server_pid = probe()["pid"]
            vm.succeed(as_user("sed -i 's/v1/v2/g' " + owner_file))
            wait_loaded("owner.ts", "v2", owner=True)
            owner_marker = cast(Probe, read_json(data + "/owner-runtime-probe.json"))
            assert owner_marker == {"pid": server_pid, "version": "v2"}
            assert main_pid() == launcher_pid

        with phase("service restart resets edits and deletes manual additions"):
            vm.succeed("systemctl restart pi-pocket.service")
            vm.wait_for_unit("pi-pocket.service")
            wait_loaded("extension.ts", "v1")
            assert main_pid() != launcher_pid
            assert probe()["version"] == "v1"
            vm.succeed("cmp " + declared + " /etc/pi-pocket-test/v1.ts")
            check_owner_removed()
            check_persistent_state()

        with phase("new generation installs changed declared extension"):
            vm.succeed(
                base_system + "/specialisation/updated/bin/switch-to-configuration test"
            )
            vm.wait_for_unit("pi-pocket.service")
            wait_loaded("extension.ts", "v2")
            assert probe()["version"] == "v2"
            vm.succeed("cmp " + declared + " /etc/pi-pocket-test/v2.ts")
            check_persistent_state()
            create_owner()

        with phase(
            "empty declaration clears all drop-ins, not config or durable sessions"
        ):
            vm.succeed(
                base_system + "/specialisation/empty/bin/switch-to-configuration test"
            )
            vm.wait_for_unit("pi-pocket.service")
            vm.wait_for_open_port(8787)
            vm.succeed("test ! -e " + declared)
            check_owner_removed()
            wait_extensions(
                lambda modules: (
                    not any(module["source"] == "drop-in" for module in modules)
                )
            )
            files = vm.succeed(
                as_user(
                    "find "
                    + data
                    + "/extensions -mindepth 1 -maxdepth 1 -printf '%f\\n'"
                )
            ).splitlines()
            assert files == ["node_modules"]
            check_persistent_state()

    except Exception:
        print(vm.execute("systemctl status pi-pocket.service --no-pager -l")[1])
        print(vm.execute("journalctl -u pi-pocket.service --no-pager -n 200")[1])
        raise


# Supplied by the NixOS driver when it executes this file.
run_service_test(
    cast(QemuMachine, globals()["machine"]), cast(Subtest, globals()["subtest"])
)
