// Internal native-document mode. This is not an extension API or an authorization boundary.
export const embedChannel = new URLSearchParams(location.search).get("embedChannel") ?? "";
export const conversationEmbed = new URLSearchParams(location.search).get("pocketEmbed") === "1";
const match = /^\/s\/([1-9]\d*)$/.exec(location.pathname);

export const embeddedConversationId =
    match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
