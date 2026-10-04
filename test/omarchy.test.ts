import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopTheme, parseColors, wallpaperFile } from "../src/server/omarchy.ts";

test("colors.toml lines become colors; tables, comments, and odd values are skipped", () => {
	const colors = parseColors(
		[
			"# A theme",
			'mode = "dark"',
			'accent = "#7aa2f7"',
			'background = "#1a1b26"  # trailing comment',
			'hyprland_active_border = "rgba(26a269ee) rgba(2ec27eee) 45deg"',
			"[table]",
			'bad = "url(javascript:alert(1)); color: red"',
			'sneaky = "url(x)"',
			'words = "red blue"',
			"number = 3",
		].join("\n"),
	);
	assert.deepEqual(colors, {
		mode: "dark",
		accent: "#7aa2f7",
		background: "#1a1b26",
		hyprland_active_border: "rgba(26a269ee) rgba(2ec27eee) 45deg",
	});
});

test("the desktop theme comes from Omarchy's current folder, with its name and wallpaper", async () => {
	const home = mkdtempSync(join(tmpdir(), "pocket-omarchy-"));
	assert.equal(await desktopTheme(home), null);
	const current = join(home, ".local/state/omarchy/current");
	mkdirSync(join(current, "theme", "backgrounds"), { recursive: true });
	writeFileSync(join(current, "theme", "colors.toml"), 'background = "#111111"\nforeground = "#eeeeee"\naccent = "#ff0000"\n');
	writeFileSync(join(current, "theme.name"), "gruvbox\n");
	const theme = await desktopTheme(home);
	assert.equal(theme?.name, "gruvbox");
	assert.equal(theme?.colors.accent, "#ff0000");
	assert.equal(theme?.wallpaper, false);
	writeFileSync(join(current, "theme", "backgrounds", "1.png"), "png");
	symlinkSync(join(current, "theme", "backgrounds", "1.png"), join(current, "background"));
	assert.equal(await wallpaperFile(home), join(current, "theme", "backgrounds", "1.png"));
	assert.equal((await desktopTheme(home))?.wallpaper, true);
});
