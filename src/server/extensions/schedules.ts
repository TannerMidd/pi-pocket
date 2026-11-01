/**
 * Scheduled messages go to Pi later, or on repeat: people set them up with /schedule, and Pi with its schedule tool,
 * to check back on something slow or for a regular job. While this is off, no scheduled message goes out; they wait
 * until it is on again.
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Schedule } from "../docs.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import type { Pip } from "../pip.ts";
import { DEFAULT_SCHEDULE_LIMITS, SCHEDULED_PREFIX, SCHEDULES_EXTENSION } from "../schedules.ts";
import { describeMoment, describeRepeat, WHEN_HELP } from "../when.ts";

const GUIDE = `Messages that start with "${SCHEDULED_PREFIX.trim()}" were set up earlier, by a person or by you with the schedule tool, and arrive at their time. Nobody may be watching when one arrives: do the work, then end with a short summary that stands on its own.`;

export default function createSchedules(host: PocketHost, web: ExtensionWeb) {
    const defaults = DEFAULT_SCHEDULE_LIMITS;

    web.settings([
        {
            name: "perSession",
            label: "Schedules per session",
            description: "How many scheduled messages one session can have at once.",
            type: "number",
            default: defaults.perSession,
            min: 1,
            max: 1000,
        },
        {
            name: "chars",
            label: "Longest message (characters)",
            description: "The longest text a scheduled message can have.",
            type: "number",
            default: defaults.chars,
            min: 100,
            max: 50000,
        },
        {
            name: "repeatMinutes",
            label: "Shortest repeat (minutes)",
            description:
                "The least time between two sendings of a repeat, such as every 10m. A short repeat can cost money: each sending is a model call.",
            type: "number",
            default: defaults.repeatMinutes,
            min: 1,
            max: 1440,
        },
        {
            name: "aheadDays",
            label: "Furthest ahead (days)",
            description: "How far ahead a message can be set with “in …”, such as in 30d.",
            type: "number",
            default: defaults.aheadDays,
            min: 1,
            max: 3650,
        },
    ]);

    // A server from before the limits has none on its schedules until it restarts.
    const apply = () => {
        if (!("limits" in host.schedules)) {
            return;
        }

        const number = (name: keyof typeof defaults) => {
            const value = web.setting(name);

            return typeof value === "number" ? value : defaults[name];
        };

        Object.assign(host.schedules.limits, {
            perSession: number("perSession"),
            chars: number("chars"),
            repeatMinutes: number("repeatMinutes"),
            aheadDays: number("aheadDays"),
        });
    };

    apply();
    web.onSettings(apply);

    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const schedule = defineTool({
        name: "schedule",
        description:
            "Send yourself a message in this conversation later, or on repeat: to check back on something slow, or for a regular job. " +
            `Actions: add (when, message), list, cancel (id). ${WHEN_HELP} Clock times are in ${zone}.`,
        parameters: Type.Object({
            action: StringEnum(["add", "list", "cancel"] as const),
            when: Type.Optional(
                Type.String({
                    description:
                        "add: when it goes out, such as in 30m, tomorrow 9:00, or every weekday 8:00",
                }),
            ),
            message: Type.Optional(
                Type.String({
                    description: "add: what you get then; write it so it stands on its own",
                }),
            ),
            id: Type.Optional(
                Type.String({ description: "cancel: the schedule's id, from add or list" }),
            ),
        }),
        // Safe to run again: an add finds the schedule this very call made, list only reads, and a cancel of a schedule
        // that is gone changes nothing.
        replay: "safe",
        execute: async (args, api) => {
            const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });
            const line = (item: Schedule) =>
                `${item.id}: ${item.every === undefined ? describeMoment(item.next, item.zone) : `${describeRepeat(item.every)}, next ${describeMoment(item.next, item.zone)}`} · ${item.text}`;

            if (args.action === "list") {
                const items = await host.schedules.list(api.conversationId);

                return reply(
                    items.length === 0 ? "Nothing is scheduled." : items.map(line).join("\n"),
                );
            }

            if (args.action === "cancel") {
                if (args.id === undefined) {
                    throw new Error("cancel needs the schedule's id.");
                }

                return reply(
                    (await host.schedules.cancel(api.conversationId, args.id))
                        ? `Cancelled ${args.id}.`
                        : `There is no schedule ${args.id}.`,
                );
            }

            if (args.when === undefined || args.message === undefined) {
                throw new Error("add needs when and message.");
            }

            const requestedBy = host.requesterOf(api.conversationId);
            const key = `${api.taskId}:${api.callId}`;
            const request = {
                when: args.when,
                text: args.message,
                key,
                ...(requestedBy === undefined ? {} : { requestedBy }),
            };
            const make = () => host.schedules.add(api.conversationId, request);
            // PiP's own schedules count toward its hourly actions. A server started before PiP counted them has no
            // countSchedule: it schedules as before until its restart.
            const pip = host.pip as Partial<Pick<Pip, "countSchedule">>;
            const added =
                typeof pip.countSchedule === "function"
                    ? await pip.countSchedule(api.conversationId, key, make)
                    : await make();

            return reply(`Scheduled ${line(added)}`);
        },
    });

    return defineExtension({
        name: SCHEDULES_EXTENSION,
        tasks: [host.schedules.task],
        tools: [schedule],
        sections: [section("schedules", () => GUIDE)],
    });
}
