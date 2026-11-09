# 05: New answers, read at the end of a run

**What to build:** with new answers on in a tab, the answers of Pi in the session that the tab
shows are read when the run ends, in order, one time each, in the words of task 02. A tab does
not read when its person is not the person Pi answers there, and a tab that shows no session
reads nothing. A tab remembers what the session had before it looked, so nothing old is read.
The page's new-answers switch turns it on, and the rail button says "auto" while it is on.

**Blocked by:** 04.

**Status:** done

- [x] New answers on, in a tab, reads the answers of the run at its end: their words without Markdown, with the owner's voice and speed.
- [x] Each message is read one time: the tab keeps the id of each message that it read.
- [x] A tab whose person is not Pi's in the session reads nothing; a tab with no session reads nothing.
- [x] The rail button shows "on" with voice output on, "auto" with new answers on, and "off" with it off.
- [x] A browser test shows that a tab with voice output off reads nothing after a new answer.
      _(A test with 2 people in one session is not in this copy: the owner's tab and another tab of the owner are the same person. The check of the person is by `pocket.me.id` against the last message from a person.)_
