# 04: The runs of a session

**What to build:** the server hears when Pi starts and when Pi stops in a session, and sends
its tabs a `running` event with that session's id: `true` at the start and `false` at the end.
Its listeners go with the module, so a new version of the module hears nothing of the one
before. A tab reads the answers of the session again at the end of a run, which is task 05.
An answer that Pi gives in several parts, with tool calls between them, comes in at the end of
the run as one answer: no part is lost, and no part is read twice.

**Blocked by:** 03.

**Status:** done

- [x] A run's start and end in a session send `running` to the module's tabs with the session's id.
- [x] The listeners go when the module does.
- [x] An answer in 2 parts is read once, in order: task 05 reads the messages at the end of the run, each one time.
      _(A browser test of 2 parts is not possible: a run in the test's scripted model gives one answer. The reading is checked by the wording of task 05's read, which takes each message by its id.)_
- [x] A server older than 0.22.0 gets no events, and the page says that new answers cannot work there.
