// The public types (`types/pocket.d.ts`) and the code agree: compiled by `npm run check`, never run. Each check goes both
// ways: the real type fits the public one, and the public one promises nothing the real one lacks. An error names the
// member that differs. `pocket` has no types in the code: `extension-ui.test.ts` compares its members.
import type {
    CommandContext as RealCommandContext,
    CommandResult as RealCommandResult,
    ConversationWebRequest as RealConversationWebRequest,
    HumanLinkedSession as RealHumanLinkedSession,
    HumanLinkedSessions as RealHumanLinkedSessions,
    ExtensionCommand,
    ExtensionModule,
    ExtensionWeb,
    LinkedSession as RealLinkedSession,
    PocketHost,
    AppEvents as RealAppEvents,
    SettingField as RealSettingField,
    AskRequest as RealAskRequest,
    AskAnswer as RealAskAnswer,
    AskField as RealAskField,
    HiddenValue as RealHiddenValue,
    CommandRun as RealCommandRun,
    BrowserPageHandle as RealBrowserPageHandle,
    BrowserControl as RealBrowserControl,
    BrowserTarget as RealBrowserTarget,
    PublicLinkInfo as RealPublicLinkInfo,
    PublicLinkRequest as RealPublicLinkRequest,
    PublicLinks as RealPublicLinks,
    PublicPageRequest as RealPublicPageRequest,
    WebRequest as RealWebRequest,
} from "../src/server/host.ts";
import type {
    Command,
    CommandContext,
    CommandResult,
    ConversationWebRequest,
    HumanLinkedSession,
    HumanLinkedSessions,
    Host,
    LinkedSession,
    Module,
    AppEvents,
    SettingField,
    AskRequest,
    AskAnswer,
    AskField,
    HiddenValue,
    CommandRun,
    BrowserPageHandle,
    BrowserControl,
    BrowserTarget,
    PublicLinkInfo,
    PublicLinkRequest,
    PublicLinks,
    PublicPageRequest,
    Web,
    WebRequest,
} from "../types/pocket.d.ts";

/**
 * The host's members that only built-in modules use: not public, so not in the types. A new host member goes in the
 * types (with `@since`) or here.
 */
type Internal =
    | "pip"
    | "pipCompaction"
    | "gallery"
    | "updates"
    | "watches"
    | "repoWatches"
    | "approvals"
    | "guard"
    | "schedules"
    | "background"
    | "goals"
    | "browsers"
    | "memory";

type PublicHost = Pick<PocketHost, keyof Host>;

export const host = (real: PublicHost): Host => real;
export const hostBack = (types: Host): PublicHost => types;
/** A member of the real host that is neither public nor internal. */
export const hostMembers = (member: Exclude<keyof PocketHost, keyof Host | Internal>): never =>
    member;

export const web = (real: ExtensionWeb): Web => real;
export const webBack = (types: Web): ExtensionWeb => types;
export const webMembers = (member: Exclude<keyof ExtensionWeb, keyof Web>): never => member;

export const context = (real: RealCommandContext): CommandContext => real;
export const contextBack = (types: CommandContext): RealCommandContext => types;
export const contextMembers = (
    member: Exclude<keyof RealCommandContext, keyof CommandContext>,
): never => member;

// Methods compare their parameters both ways, so the shapes they take are checked here on their own.
export const request = (real: RealWebRequest): WebRequest => real;
export const requestBack = (types: WebRequest): RealWebRequest => types;
export const conversationRequest = (real: RealConversationWebRequest): ConversationWebRequest =>
    real;
export const conversationRequestBack = (
    types: ConversationWebRequest,
): RealConversationWebRequest => types;
export const humanLinked = (real: RealHumanLinkedSession): HumanLinkedSession => real;
export const humanLinkedBack = (types: HumanLinkedSession): RealHumanLinkedSession => types;
export const humanLinks = (real: RealHumanLinkedSessions): HumanLinkedSessions => real;
export const humanLinksBack = (types: HumanLinkedSessions): RealHumanLinkedSessions => types;
export const command = (real: ExtensionCommand): Command => real;
export const commandBack = (types: Command): ExtensionCommand => types;
export const result = (real: RealCommandResult): CommandResult => real;
export const resultBack = (types: CommandResult): RealCommandResult => types;
export const publicLinks = (real: RealPublicLinks): PublicLinks => real;
export const publicLinksBack = (types: PublicLinks): RealPublicLinks => types;
export const publicLinkInfo = (real: RealPublicLinkInfo): PublicLinkInfo => real;
export const publicLinkInfoBack = (types: PublicLinkInfo): RealPublicLinkInfo => types;
export const publicLinkRequest = (real: RealPublicLinkRequest): PublicLinkRequest => real;
export const publicLinkRequestBack = (types: PublicLinkRequest): RealPublicLinkRequest => types;
export const publicPageRequest = (real: RealPublicPageRequest): PublicPageRequest => real;
export const publicPageRequestBack = (types: PublicPageRequest): RealPublicPageRequest => types;
export const askRequest = (real: RealAskRequest): AskRequest => real;
export const askRequestBack = (types: AskRequest): RealAskRequest => types;
export const askAnswer = (real: RealAskAnswer): AskAnswer => real;
export const askAnswerBack = (types: AskAnswer): RealAskAnswer => types;
export const askField = (real: RealAskField): AskField => real;
export const askFieldBack = (types: AskField): RealAskField => types;
export const hiddenValue = (real: RealHiddenValue): HiddenValue => real;
export const hiddenValueBack = (types: HiddenValue): RealHiddenValue => types;
export const commandRun = (real: RealCommandRun): CommandRun => real;
export const commandRunBack = (types: CommandRun): RealCommandRun => types;
export const browserPageHandle = (real: RealBrowserPageHandle): BrowserPageHandle => real;
export const browserPageHandleBack = (types: BrowserPageHandle): RealBrowserPageHandle => types;
export const browserControl = (real: RealBrowserControl): BrowserControl => real;
export const browserControlBack = (types: BrowserControl): RealBrowserControl => types;
export const browserTarget = (real: RealBrowserTarget): BrowserTarget => real;
export const browserTargetBack = (types: BrowserTarget): RealBrowserTarget => types;
export const appEvents = (real: RealAppEvents): AppEvents => real;
export const appEventsBack = (types: AppEvents): RealAppEvents => types;
export const settingField = (real: RealSettingField): SettingField => real;
export const settingFieldBack = (types: SettingField): RealSettingField => types;
export const linked = (real: RealLinkedSession): LinkedSession => real;
export const linkedBack = (types: LinkedSession): RealLinkedSession => types;

/** A module written against the public types is one the loader takes. */
export const module = (types: Module): ExtensionModule => types;
