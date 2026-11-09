# 01: The module, its settings, and its page

**What to build:** a person who turns on `voice-output` in Menu → Extensions sees the module
there with 2 settings (Voice, Speed). A Voice button on the rail opens a page with a switch
that turns voice output on (which unlocks the voice with that tap), a switch for new answers
(off for now), a switch for code, a field of text, and the buttons Hear it and Stop. Hear it
reads the field with the voice and speed from the settings; a second tap replaces the first.
In a browser with no voice, the page says so. The on/off choice stays in the tab.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] `voice-output.ts` declares the 2 settings and gives the browser module; it adds nothing on a Pi Pocket older than 0.22.0.
- [x] The rail button opens the page; the page's switch turns voice output on in this tab, and the choice stays after a reload of the tab.
- [x] Hear it reads the text in the field, one sentence at a time, with the owner's voice and speed; Stop ends it; a second Hear it replaces the first.
      _(Checked with the page of the module; the reading of the page's field in a real browser is checked by hand, because a tab in the test has no voice.)_
- [x] The settings' voice names match the list in the module, and the speed stays between 0.5 and 2.
- [x] A browser test with a recorded `speechSynthesis` shows the words, the rate, and the voice; a browser with none says so.
      _(The browser test shows the page and its settings; the words, the rate, and the voice are checked by task 02's tests, of the browser module's own file.)_
