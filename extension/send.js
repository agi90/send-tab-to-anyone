import { StateStorage } from './state.js';
import { HOST } from './constants.js';

document.addEventListener("DOMContentLoaded", init);

const CONNECTION_STATUS = {
    "not-connected": "Not Connected",
    "connected": "",
    "error": "Connection Error",
};

const ENCODER = new TextEncoder();

async function send(data) {
    const page = await browser.runtime.getBackgroundPage();
    page.sendMessage(data);
}

function addFriend(friendId) {
    send({ type: "add-friend", friendId });
}

async function sendMessage(storage, tab, friend) {
    const encoded = ENCODER.encode(tab);
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        friend.publicKey,
        encoded);

    const decoded = arrayBufferToBase64(encrypted);
    send({ type: "send-tab", friendId: friend.id, tab: decoded });
}

function update(storage) {
    const { state } = storage;

    if (!state.userId) {
        document.getElementById("new-user").style.display = "block";
        document.getElementById("existing-user").style.display = "none";
        return;
    }

    document.getElementById("new-user").style.display = "none";
    document.getElementById("existing-user").style.display = "block";

    const connectionStatus = CONNECTION_STATUS[state.status];
    document.getElementById("connection-status").innerText = connectionStatus;
    document.getElementById("user-id").innerText = state.userId;
    document.querySelector(".display-name").innerText = state.displayName;
    const friendsDiv = document.getElementById("friends");

    if (state.friends.length == 0) {
        document.querySelector(".send-tab-to-text").style.display = "none";
        document.querySelector(".send-tab-divider").style.display = "none";
    }

    friendsDiv.innerHTML = "";
    for (const friend of state.friends) {
        const button = document.createElement("button");
        button.type = "button";
        button.innerText = friend.displayName;
        button.value = friend.id;
        button.classList.add("user-button");
        button.addEventListener('click', async event => {
            const tabs =
                await browser.tabs.query({active: true, currentWindow: true});
            console.log(tabs[0].url);
            sendMessage(storage, tabs[0].url, friend);
            button.innerText += "✔️";
            button.classList.add("sent");
            button.disabled = true;
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

async function init() {
    const page = await browser.runtime.getBackgroundPage();
    const storage = page.storage;

    const { state } = storage;
    const { userId, displayName } = state;

    update(storage);

    document.getElementById("register").addEventListener("click", async ev => {
        const displayName = document.getElementById("display-name").value;
        const page = await browser.runtime.getBackgroundPage();
        page.register(storage, displayName);
    });

    document.getElementById("add-friend").addEventListener("click", ev => {
        const field = document.getElementById("friend-id");
        const friendId = field.value;
        field.value = "";

        addFriend(friendId);
    });

    document.getElementById("copy").addEventListener("click", ev => {
        navigator.clipboard.writeText(state.userId);
    });

    if (state.friends.length > 0) {
        document.getElementById("friend-code-wrapper").style.display = "none";

        document.getElementById("show-friend-code").addEventListener("click", ev => {
            document.getElementById("friend-code-wrapper").style.display = "block";
            document.getElementById("show-friend-code").style.display = "none";
        });
    }
}

window.update = update;
