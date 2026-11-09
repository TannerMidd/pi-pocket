# 02: An answer's words, without its Markdown

**What to build:** the words that a person hears for an answer are the answer's own words:
no `**`, `#`, backticks, list marks, link addresses, HTML tags, or emoji. A heading or a list
item is a sentence. A table says "table". A fenced block says "bash code, 12 lines" (or "code,
1 line"), and inline code says "code". When the tab turns on code, the block's lines and the
inline text are read. The `[via …]` marker that a message from another agent starts with is
not read. The pieces come one sentence at a time, and a long sentence is cut at a comma or a
space. The same function is used by Hear it, Read aloud, and new answers.

**Blocked by:** 01.

**Status:** done

- [x] Plain prose, headings, lists, emphasis, links, images, quotes, and HTML tags give their words alone.
- [x] A fenced block with a language says "<language> code, N lines"; without a language, "code, N lines"; with code on, its lines are read.
- [x] Inline code says "code", or its text with code on.
- [x] A table says "table" at each of its rows; emoji and a `[via …]` marker give no word.
      _(A `#` in front of a number stays one word with the number, as the test shows: a reader says it as the answer does.)_
- [x] A test checks each shape on its own; no Markdown marker survives in what is read.
