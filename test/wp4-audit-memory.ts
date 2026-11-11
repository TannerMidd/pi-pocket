import { type Builder } from "./wp4-audit.ts";

export function memory(b: Builder) {
    const f = "memory.js";

    b.add(
        f,
        "155:17",
        "translated",
        "Source",
        "Pi, self and author name",
        ["Source"],
        ["source.who.content"],
        ["Source::lesson.byPi", "Source::lesson.byName"],
    );
    b.add(
        f,
        "156:62",
        "translated",
        "Source",
        "for-name keeps person name",
        ["Source"],
        ["source.span.for-name"],
        ["Source::lesson.byName"],
    );
    b.add(
        f,
        "156:11",
        "structural-reviewed",
        "Source",
        "conditional name and linked author title",
        ["Source"],
        ["source.span.for-name"],
        ["Source::lesson.from.title", "Source::lesson.byName"],
    );
    b.add(
        f,
        "162:62",
        "translated",
        "Source",
        "reach phrase and translated reach producer",
        ["Source", "reach"],
        ["source.span.content", "reach.everywhere-every-session-pi-p", "reach.project"],
        ["Source::reach(lesson)", "reach::lesson.projectName"],
    );
    b.add(
        f,
        "162:11",
        "structural-reviewed",
        "Source",
        "pending conditional with reach producer",
        ["Source", "reach"],
        ["source.span.content", "reach.everywhere-every-session-pi-p", "reach.project"],
        ["Source::reach(lesson)"],
    );
    b.add(
        f,
        "221:13 224:23",
        "translated",
        "Lesson",
        "proposal header and author contents",
        ["Lesson"],
        ["lesson.span.content", "lesson.span.proposes-forgetting", "lesson.span.proposes"],
        ["Lesson::lesson.proposal.byName", "Lesson::lesson.proposal.text"],
    );
    b.add(
        f,
        "237:17",
        "translated",
        "Lesson",
        "action buttons and approval notice",
        ["Lesson"],
        [
            "lesson.button.approve",
            "lesson.button.discard",
            "lesson.button.withdraw",
            "lesson.button.edit",
            "lesson.button.forget",
            "lesson.button.forget.forget",
            "lesson.text.approved-pi-goes-next",
        ],
    );
    b.add(
        f,
        "240:25",
        "translated",
        "Lesson",
        "approval button and new notice",
        ["Lesson"],
        ["lesson.button.approve", "lesson.text.approved-pi-goes-next"],
    );
    b.add(
        f,
        "256:31",
        "translated",
        "Lesson",
        "discard/withdraw branches",
        ["Lesson"],
        ["lesson.button.discard", "lesson.button.withdraw"],
    );
    b.add(
        f,
        "276:31",
        "translated",
        "Lesson",
        "forget/confirm branches",
        ["Lesson"],
        ["lesson.button.forget", "lesson.button.forget.forget"],
    );
    b.add(
        f,
        "288:36 289:74",
        "translated",
        "Group",
        "title and empty passed by translated Group callers",
        ["Group", "MemorySheet"],
        [
            "memory-sheet.title.approve",
            "memory-sheet.title.project",
            "memory-sheet.title.everywhere",
            "memory-sheet.p.no-memories-waiting",
            "memory-sheet.p.nothing-yet",
        ],
        ["Group::${title}", "Group::${empty}", "MemorySheet::<${Group}"],
    );
    b.add(
        f,
        "289:11",
        "structural-reviewed",
        "Group",
        "empty and child Lesson forwarding",
        ["Group", "MemorySheet", "Lesson"],
        ["memory-sheet.p.no-memories-waiting", "memory-sheet.p.nothing-yet"],
        ["Group::${empty}", "Group::<${Lesson}"],
    );
    b.add(
        f,
        "293:19",
        "structural-reviewed",
        "Group",
        "lesson map preserves id and component",
        ["Group", "Lesson"],
        [],
        ["Group::lessons.map", "Group::key=${lesson.id}", "Group::<${Lesson}"],
    );
    b.add(
        f,
        "318:39 324:39 330:39 364:39 380:35",
        "translated",
        "MemorySheet",
        "pending or memory title at every branch",
        ["MemorySheet"],
        ["memory-sheet.title.pending-memories", "memory-sheet.title.memory"],
        ["MemorySheet::pendingOnly", "MemorySheet::title=${title}"],
    );
    b.add(
        f,
        "366:17",
        "translated",
        "MemorySheet",
        "pending approval explanation",
        ["MemorySheet"],
        ["memory-sheet.p.memories-waiting-approval-across"],
    );
    b.add(
        f,
        "382:13",
        "translated",
        "MemorySheet",
        "intro with project name or PiP branch",
        ["MemorySheet"],
        [
            "memory-sheet.p.short-lessons-pi-keeps",
            "memory-sheet.p.those-for-project",
            "memory-sheet.p.pi-p-keeps-lessons-everywhere",
        ],
        ["MemorySheet::project.name"],
    );
    b.add(
        f,
        "385:13",
        "structural-reviewed",
        "MemorySheet",
        "form and Group caller labels",
        ["MemorySheet", "Group"],
        [
            "memory-sheet.placeholder.e-g-run-tests",
            "memory-sheet.aria-label.for",
            "memory-sheet.button.this-project",
            "memory-sheet.button.everywhere",
            "memory-sheet.button.remember",
            "memory-sheet.title.approve",
            "memory-sheet.title.project",
            "memory-sheet.title.everywhere",
            "memory-sheet.p.nothing-yet",
        ],
        ["MemorySheet::<${Group}"],
    );
    b.add(
        f,
        "402:25",
        "already-wired",
        "MemorySheet",
        "existing radiogroup and both choices",
        ["MemorySheet"],
        [
            "memory-sheet.aria-label.for",
            "memory-sheet.button.this-project",
            "memory-sheet.button.everywhere",
        ],
    );
    b.add(
        f,
        "507:20",
        "translated",
        "LessonCall",
        "what/reach/waiting person producers",
        ["LessonCall", "reach"],
        [
            "lesson-call.div.waits",
            "lesson-call.what.new-lesson",
            "lesson-call.what.forgetting-lesson",
            "lesson-call.what.new-text-lesson",
            "lesson-call.div.content",
            "lesson-call.div.owner",
            "reach.everywhere-every-session-pi-p",
            "reach.project",
        ],
        ["LessonCall::reach(lesson)"],
    );
    b.add(
        f,
        "511:13",
        "translated",
        "LessonCall",
        "existing buttons and new notices",
        ["LessonCall"],
        [
            "lesson-call.button.approve",
            "lesson-call.button.discard",
            "lesson-call.text.approved-pi-goes-next",
            "lesson-call.text.discarded",
        ],
    );
    b.add(
        f,
        "159:73",
        "content-excluded",
        "Source",
        "author session title",
        ["Source"],
        [],
        ["Source::lesson.from.title"],
    );
    b.add(
        f,
        "161:16",
        "content-excluded",
        "Source",
        "shared time helper, not raw fixed prose",
        ["Source"],
        [],
        ["Source::timeAgo(lesson.updatedAt ?? lesson.createdAt)"],
    );
    b.add(
        f,
        "219:36",
        "content-excluded",
        "Lesson",
        "author lesson",
        ["Lesson"],
        [],
        ["Lesson::lesson.text"],
    );
    b.add(
        f,
        "226:75",
        "content-excluded",
        "Lesson",
        "author proposal",
        ["Lesson"],
        [],
        ["Lesson::lesson.proposal.text"],
    );
    b.add(
        f,
        "382:143",
        "content-excluded",
        "MemorySheet",
        "project name as a value",
        ["MemorySheet"],
        ["memory-sheet.p.those-for-project"],
        ["MemorySheet::project.name"],
    );
    b.add(
        f,
        "508:40",
        "content-excluded",
        "LessonCall",
        "lesson or proposal text",
        ["LessonCall"],
        [],
        ["LessonCall::lesson.text", "LessonCall::lesson.proposal.text", "LessonCall::${text}"],
    );
    b.add(
        f,
        "226:19",
        "structural-reviewed",
        "Lesson",
        "conditional author proposal text",
        ["Lesson"],
        [],
        ["Lesson::lesson.proposal.text"],
    );
}
