document.addEventListener("DOMContentLoaded", init);

const CONNECTION_STATUS = {
    "not-connected": "Not Connected",
    "connected": "Connected",
    "error": "Connection Error",
};

const RSA_CONFIG = {
    name: "RSA-OAEP",
    modulusLength: 4096,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
};

const CRYPTO_METHODS = ["encrypt", "decrypt"];

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function send(ws, data) {
    ws.send(JSON.stringify(data));
}

function addFriend(ws, friendId) {
    send(ws, { type: "add-friend", friendId });
}

async function sendMessage(state, tab, friend) {
    const encoded = ENCODER.encode(tab);
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        friend.publicKey,
        encoded);

    const decoded = arrayBufferToBase64(encrypted);
    send(state.ws, { type: "send-tab", friendId: friend.id, tab: decoded });
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

function update(state) {
    const connectionStatus = CONNECTION_STATUS[state.status];
    document.getElementById("connection-status").innerText = connectionStatus;
    document.getElementById("user-id").value = state.userId;
    document.getElementById("display-name").value = state.displayName;
    const friendsDiv = document.getElementById("friends");

    friendsDiv.innerHTML = "";
    for (const friend of state.friends) {
        const button = document.createElement("button");
        button.type = "button";
        button.innerText = friend.displayName;
        button.value = friend.id;
        button.addEventListener('click', event => {
            const tab = document.getElementById("tab").value;
            sendMessage(state, tab, friend);
        });
        friendsDiv.appendChild(button);
    }
}

// TODO: figure out a better way for this
function arrayBufferToBase64(buffer) {
    var binary = '';
    var bytes = new Uint8Array(buffer);
    var len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    var binary_string = window.atob(base64);
    var len = binary_string.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

async function receiveTab(json, state) {
    const span = document.createElement("span");
    const buffer = base64ToArrayBuffer(json.tab);
    const decrypted = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        state.privateKey,
        buffer);
    const decoded = DECODER.decode(decrypted);

    span.innerText = decoded;
    document.getElementById("received").appendChild(span);
}

async function connect(state, userId, displayName) {
    const ws = new WebSocket("ws://127.0.0.1:5000");
    state.ws = ws;

    // Connection opened
    ws.addEventListener('open', async event => {
        state.status = "connected";
        state.userId = state.userId || userId;
        state.displayName = state.displayName || displayName;

        if (state.userId) {
            send(ws, { type: "login", userId: state.userId });
            send(ws, { type: "friends", userId: state.userId });
        } else {
            const keyPair = await window.crypto.subtle.generateKey(
                RSA_CONFIG,
                true,
                CRYPTO_METHODS);

            const publicKey = await crypto.subtle.exportKey(
                "jwk", keyPair.publicKey);
            const privateKey = await crypto.subtle.exportKey(
                "jwk", keyPair.privateKey);

            state.publicKey = keyPair.publicKey;
            state.privateKey = keyPair.privateKey;

            const exportedState = {
                ... state,
                privateKey,
                publicKey
            };

            localStorage.setItem('state', JSON.stringify(exportedState));
            send(ws, { type: "register", displayName, publicKey });
        }

        update(state);
    });

    ws.addEventListener('close', event => {
        state.status = "not-connected";
        update(state);
    });

    ws.addEventListener('error', event => {
        state.status = "error";
        update(state);
    });

    ws.addEventListener('message', async event => {
        const { data } = event;
        const json = JSON.parse(data);
        console.log('Message from server ', json);

        switch (json.type) {
            case "user": {
                const { userId, displayName } = json;
                state.userId = userId;
                state.displayName = displayName;
                update(state);
                break;
            }

            case "friends": {
                state.friends = await parseFriends(json.friends);
                update(state);
                break;
            }

            case "receive-tab": {
                receiveTab(json, state);
                break;
            }
        }
    });
}

async function init() {
    const storage = localStorage.getItem('state');

    let state;
    if (storage) {
        state = JSON.parse(storage);
        state.publicKey = await crypto.subtle.importKey(
            "jwk",
            state.publicKey,
            { name: "RSA-OAEP", hash: "SHA-256" },
            true,
            ["encrypt"]);
        state.privateKey = await crypto.subtle.importKey(
            "jwk",
            state.privateKey,
            RSA_CONFIG,
            true,
            ["decrypt"]);
    } else {
        state = {
            userId: "",
            status: "not-connected",
            friends: [],
        };
    }

    document.getElementById("connect").addEventListener("click", ev => {
        const userId = document.getElementById("user-id").value;
        const displayName = document.getElementById("display-name").value;
        connect(state, userId, displayName);
    });

    document.getElementById("send").addEventListener("click", ev => {
        send(state.ws, { type: "ping", userId: state.userId });
    });

    document.getElementById("add-friend").addEventListener("click", ev => {
        const friendId = document.getElementById("friend-id").value;
        addFriend(state.ws, friendId);
    });
}
