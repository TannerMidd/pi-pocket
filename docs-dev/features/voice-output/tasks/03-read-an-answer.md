# 03: Read aloud under an answer

**What to build:** a person taps **Read aloud** under any answer of Pi and hears that answer,
as the words of task 02, with the owner's voice and speed. A second read, or Stop,
replaces what plays. An answer with code follows the page's code switch.

**Blocked by:** 02.

**Status:** done

- [x] Read aloud shows under each finished answer, next to the app's own actions.
- [x] The words that play have no Markdown in them.
      _(Checked against the browser module's own file, which the reading uses; a tab in the test has no voice.)_
- [x] A browser test shows Read aloud under an answer.
- [x] With the voice off, the answer is read, and the page says how to turn voice output on.
      _(The page says it in its words; no notice comes from a read that the tab cannot make.)_
