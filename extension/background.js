import { StateStorage } from './state.js';
import { HOST } from './constants.js';

const RSA_CONFIG = {
    name: "RSA-OAEP",
    modulusLength: 4096,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
};

const CRYPTO_METHODS = ["encrypt", "decrypt"];

function send(ws, data) {
    ws.send(JSON.stringify(data));
}

async function parseFriends(friends) {
    // Deserialize publicKey
    for (const friend of friends) {
        friend.publicKey = await crypto.subtle.importKey(
            "jwk",
            friend.publicKey,
            { name: "RSA-OAEP", hash: "SHA-256" },
            true,
            ["encrypt"]);
    }

    return friends;
}

async function update(storage) {
    storage.save();

    const windows = await browser.extension.getViews({ type: 'popup' });
    console.log(windows);
    for (const window of windows) {
        window.update(storage);
    }
}

async function register(ws, storage, displayName) {
    // Generate keys for encrypted communication
    const keyPair = await window.crypto.subtle.generateKey(
            RSA_CONFIG,
            true,
            CRYPTO_METHODS);

    const { state } = storage;

    state.publicKey = keyPair.publicKey;
    state.privateKey = keyPair.privateKey;

    const publicKey = await crypto.subtle.exportKey(
            "jwk", state.publicKey);

    update(storage);

    send(ws, { type: "register", displayName, publicKey });
}

async function init() {
    const storage = new StateStorage();
    await storage.init();

    const { state } = storage;
    console.log(state);

    const ws = new WebSocket(HOST);
    ws.addEventListener('message', async event => {
        const { data } = event;
        const json = JSON.parse(data);
        console.log('Message from server ', json);

        switch (json.type) {
            case "pong": {
                break;
            }
            case "receive-tab": {
                receiveTabs(state, [json]);
                break;
            }
            case "user": {
                const { userId, displayName, friends, messages } = json;
                state.userId = userId;
                state.displayName = displayName;
                state.friends = await parseFriends(friends);
                if (messages.length > 0) {
                    receiveTabs(state, messages);
                }
                state.registering = false;
                update(storage);
                break;
            }
            case "friends": {
                state.friends = await parseFriends(json.friends);
                update(storage);
                break;
            }
            default: {
                console.log('Unrecognized message', json);
                // Notify popups
                const windows = browser.extension.getViews({ type: 'popup' });
                for (const window of windows) {
                    window.onMessage(json);
                }
            }
        }
    });

    ws.addEventListener('open', async event => {
        state.status = "connected";

        send(ws, { type: "login", userId: state.userId });

        update(storage);

        const heartBeat = () => {
            send(ws, { type: "ping" });
            setTimeout(heartBeat, 30000);
        };

        heartBeat();
    });

    ws.addEventListener('close', event => {
        console.log("Reconnecting...");
        init();
    });

    ws.addEventListener('error', event => {
        console.log("Reconnecting...");
        init();
    });

    window.sendMessage = data => {
        console.log(data);
        ws.send(JSON.stringify(data));
    };

    window.storage = storage;

    window.register = (storage, displayName) =>
        register(ws, storage, displayName);
}

const DECODER = new TextDecoder();

function base64ToArrayBuffer(base64) {
    var binary_string = window.atob(base64);
    var len = binary_string.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

async function decryptMessage(state, message) {
    const buffer = base64ToArrayBuffer(message);
    const decrypted = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        state.privateKey,
        buffer);
    return DECODER.decode(decrypted);
}

async function receiveTabs(state, messages) {
    const decrypted = await Promise.all(
            messages.map(message => decryptMessage(state, message.tab)));

    const fromMap = new Map();
    for (const message of messages) {
        const { from } = message;
        if (fromMap.has(from)) {
            fromMap.set(from, fromMap.get(from) + 1);
        } else {
            fromMap.set(from, 1);
        }
    }

    const message = Array.from(fromMap).reduce(
        (acc, [friendId, tabNumber], index) => {
            const from = state.friends.find(friend => friend.id == friendId);
            const tab = tabNumber == 1 ? "a tab" : tabNumber + " tabs";
            const comma = index > 0 ? ", " : "";
            return acc + comma + `${from.displayName} sent ${tab}`;
        }, ""
    );

    const tabs = messages.length > 1 ? `${messages.length} tabs` : "a tab";

    if (messages.length == 1) {
        // Special case for 1 message
        browser.notifications.create({
            "type": "basic",
            "iconUrl": browser.runtime.getURL("icon-96.png"),
            "title": message,
            "message": decrypted[0],
        });
    } else {
        browser.notifications.create({
            "type": "basic",
            "iconUrl": browser.runtime.getURL("icon-96.png"),
            "title": `Received ${tabs}`,
            "message": message,
        });
    }

    for (const tab of decrypted) {
        browser.tabs.create({
            url: tab,
            active: false
        });
    }
}

init();
