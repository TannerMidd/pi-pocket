# Voice output

A drop-in extension that reads Pi's answers aloud, in the browser that you chat in, with the
browser's own voice. You tap **Read aloud** under an answer, or you turn on **New answers** and
a tab reads each answer of Pi as its run ends.

It reads nothing but Pi's answers. It reads no file and no session on the server, and it calls no
other service.

## Install

1. Copy `voice-output.ts` and the folder `voice-output/` into your drop-in folder:
   `~/.pi-pocket/extensions/`. The folder goes beside the file, with the same name: Pi Pocket
   finds the module's browser part there.
2. Open Menu → **Extensions**. Find **Voice output** in the group **Yours**, turn it on, and
   confirm.
3. Open a session. A **Voice** button is on the rail.

## Use

- **A tap under one answer.** **Read aloud** shows under each finished answer. It reads that
  answer, sentence by sentence, and it replaces what plays.
- **Each new answer.** The **Voice** page has three switches:
    - **Voice output** turns it on in this tab. The tap is also what a phone needs before a page can
      speak, so turn it on first.
    - **New answers** reads the answers of Pi in the session that the tab shows, when the last
      message there is yours. Other tabs and other people read nothing. It needs the server to say
      when Pi starts and ends: Pi Pocket 0.22.0 or later.
    - **Code in answers** reads a code block's lines. Without it, a block says "bash code, 12 lines".
- **Hear it** in the page reads the text in the field, so that you can try the voice.

## What each side chooses

- **The owner, for every tab**, in Menu → Extensions, under **Voice output**: the **voice** and
  the **speed**. "Best" takes the first natural or Google English voice that the browser has.
- **Each tab**: voice output, new answers, and code. A tab keeps these in its `sessionStorage`,
  under `x.voice-output.state`, and forgets them when it closes.

## Limits

- The browser starts no speech without a tap. Turn voice output on in each tab that you use.
- A tab that the browser hides, or a phone whose screen locks, stops the voice. The answer
  continues reading from where it stopped when the tab shows again only in some browsers.
- The voice is the browser's. On a phone, the voices of the system are there; on a desktop, often
  fewer. A server-side voice is not part of this extension.
- Chromium stops one long utterance after about 15 seconds: this module reads one sentence at a
  time for that reason.
