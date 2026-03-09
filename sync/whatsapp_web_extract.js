// JavaScript payload injected into Safari's WhatsApp Web tab via AppleScript.
// Uses WhatsApp's internal Meta require() module system to access decrypted messages.
//
// Communication: sets window._thyself with JSON result, polled by AppleScript.

window._thyself = 'working';
window._thyselfMessages = [];
(async () => {
    try {
        const { ChatCollection } = self.require('WAWebChatCollection');
        const { loadRecentMsgs } = self.require('WAWebChatLoadMessages');
        const { decryptDataInMsgModel } = self.require('WAWebMsgOpaqueData');
        const chats = ChatCollection.getModelsArray();

        const cutoffTs = __CUTOFF_TS__;
        const allMsgs = [];
        let loadErrors = 0;
        let totalMsgsScanned = 0;
        let chatsWithMsgs = 0;
        let filteredByType = 0;
        let filteredByTime = 0;
        let filteredByBody = 0;

        for (const chat of chats) {
            try {
                await loadRecentMsgs(chat);
            } catch (e) {
                loadErrors++;
            }

            const msgs = chat.msgs ? chat.msgs.getModelsArray() : [];
            if (msgs.length > 0) chatsWithMsgs++;
            totalMsgsScanned += msgs.length;

            for (const m of msgs) {
                if (!m.t || m.t < cutoffTs) {
                    filteredByTime++;
                    continue;
                }
                if (m.type !== 'chat') {
                    filteredByType++;
                    continue;
                }
                if (!m.body && m.msgRowOpaqueData) {
                    try { await decryptDataInMsgModel(m); } catch (e) { /* skip */ }
                }
                if (!m.body) {
                    filteredByBody++;
                    continue;
                }
                allMsgs.push({
                    id: m.id ? m.id._serialized : null,
                    body: m.body,
                    from: m.from ? m.from._serialized : null,
                    to: m.to ? m.to._serialized : null,
                    chat: chat.id ? chat.id._serialized : null,
                    chatName: chat.name || chat.formattedTitle || null,
                    timestamp: m.t,
                    fromMe: m.id ? m.id.fromMe : false,
                    type: m.type,
                    isGroup: chat.isGroup || false
                });
            }

            if (allMsgs.length % 100 === 0 && allMsgs.length > 0) {
                await new Promise(r => setTimeout(r, 50));
            }
        }

        window._thyselfMessages = allMsgs;
        window._thyselfTotal = allMsgs.length;
        window._thyself = JSON.stringify({
            status: 'done',
            count: allMsgs.length,
            totalChats: chats.length,
            chatsWithMsgs: chatsWithMsgs,
            totalMsgsScanned: totalMsgsScanned,
            loadErrors: loadErrors,
            filteredByTime: filteredByTime,
            filteredByType: filteredByType,
            filteredByBody: filteredByBody,
            cutoffUsed: cutoffTs
        });
    } catch (e) {
        window._thyself = JSON.stringify({
            status: 'error',
            error: e.message,
            stack: e.stack ? e.stack.substring(0, 500) : ''
        });
    }
})();
