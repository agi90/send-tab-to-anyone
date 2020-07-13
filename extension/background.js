import { StateStorage } from "./state.js";
import { HOST } from "./constants.js";

const RSA_CONFIG = {
  name: "RSA-OAEP",
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
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
      ["encrypt"]
    );
  }

  return friends;
}

async function update(storage) {
  await storage.save();
  const { state } = storage;
  const { messages } = state;

  if (state.status !== "connected") {
    browser.browserAction.setBadgeText({ text: "!" });
    // popup === null enables the popup
    browser.browserAction.setPopup({ popup: null });
  } else if (messages.length === 0) {
    browser.browserAction.setBadgeText({ text: "" });
    // popup === null enables the popup
    browser.browserAction.setPopup({ popup: null });
  } else {
    browser.browserAction.setBadgeText({ text: messages.length + "" });
    // popup !== null disables the popup, so that clicking on the
    // button triggers opening the tabs
    browser.browserAction.setPopup({ popup: "" });
  }

  const message = {
    type: "update",
    state: storage.state,
  };

  browser.runtime.sendMessage(message).catch((e) => {
    // BrowserAction popup is not open, nothing to do
  });
}

async function register(ws, storage, displayName) {
  // Generate keys for encrypted communication
  const keyPair = await window.crypto.subtle.generateKey(
    RSA_CONFIG,
    true,
    CRYPTO_METHODS
  );

  const { state } = storage;

  state.publicKey = keyPair.publicKey;
  state.privateKey = keyPair.privateKey;

  const publicKey = await crypto.subtle.exportKey("jwk", state.publicKey);

  update(storage);

  send(ws, { type: "register", displayName, publicKey });
}

const storage = new StateStorage();

async function connect() {
  const { state } = storage;
  const ws = new WebSocket(HOST);

  ws.addEventListener("message", async (event) => {
    const { data } = event;
    const json = JSON.parse(data);
    console.log("Message from server ", json);

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
        throw new Error(`Unknown message type: ${data}`);
      }
    }
  });

  ws.addEventListener("open", async (event) => {
    state.status = "connected";
    state.connection_retry = 0;

    send(ws, { type: "login", userId: state.userId });

    update(storage);

    const heartBeat = () => {
      send(ws, { type: "ping" });
      setTimeout(heartBeat, 30000);
    };

    heartBeat();
  });

  ws.addEventListener("close", (event) => {
    state.connection_retry += 1;
    state.status = "not-connected";
    window.ws = null;
    update(storage);

    const delay = Math.pow(5, state.connection_retry);
    console.log(`Reconnecting in ${delay}s...`);
    setTimeout(connect, delay * 1000);
  });

  ws.addEventListener("error", (event) => {
    console.log("Error, closing websocket...");
    ws.close();
  });

  window.ws = ws;
}

async function init() {
  await connect();

  const { state } = storage;
  console.log(state);

  browser.runtime.onMessage.addListener(async (message) => {
    switch (message.type) {
      case "send": {
        console.log(message);
        window.ws.send(JSON.stringify(message.data));
        break;
      }
      case "register": {
        state.registering = true;
        update(storage);
        register(window.ws, storage, message.displayName);
        break;
      }
      case "get-state": {
        return Promise.resolve(JSON.parse(JSON.stringify(storage.state)));
      }
      case "send-tab": {
        const { friendId, tab } = message;
        const friend = state.friends.find((friend) => friend.id === friendId);
        const encrypted = await encryptMessage(tab, friend);
        send(window.ws, {
          type: "send-tab",
          friendId: friend.id,
          tab: encrypted,
        });
        break;
      }
      default: {
        throw new Error(
          `Unknown message type: ${message.type} ${message.data}`
        );
      }
    }
  });

  // Open tabs when the user clicks on the browser action icon
  browser.browserAction.onClicked.addListener(() => {
    for (const tab of state.messages) {
      browser.tabs.create({
        url: tab,
        active: true,
      });
    }

    state.messages = [];
    update(storage);
  });

  window.storage = storage;
}

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

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
    buffer
  );
  return DECODER.decode(decrypted);
}

async function encryptMessage(message, friend) {
  const encoded = ENCODER.encode(message);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    friend.publicKey,
    encoded
  );

  return arrayBufferToBase64(encrypted);
}

// Sanitize tabs coming from external senders
function filterTab(tab) {
  try {
    const url = new URL(tab);
    // We only support HTTP(s) for security
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      console.error(`Rejecting ${tab}, protocol not supported`);
      return false;
    }
    return true;
  } catch (ex) {
    // Not a valid URL
    console.error(`Rejecting ${tab}, invalid URL`);
    return false;
  }
}

// TODO: figure out a better way for this
function arrayBufferToBase64(buffer) {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  var len = bytes.byteLength;
  for (var i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

async function receiveTabs(state, messages) {
  const decrypted = (
    await Promise.all(
      messages.map((message) => decryptMessage(state, message.tab))
    )
  ).filter(filterTab);

  if (decrypted.length === 0) {
    // No messages
    return;
  }

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
      const from = state.friends.find((friend) => friend.id === friendId);
      const tab = tabNumber === 1 ? "a tab" : tabNumber + " tabs";
      const comma = index > 0 ? ", " : "";
      return acc + comma + `${from.displayName} sent ${tab}`;
    },
    ""
  );

  const tabs = messages.length > 1 ? `${messages.length} tabs` : "a tab";

  if (messages.length === 1) {
    // Special case for 1 message
    browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icon-96.png"),
      title: message,
      message: decrypted[0],
    });
  } else {
    browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("icon-96.png"),
      title: `Received ${tabs}`,
      message: message,
    });
  }

  for (const tab of decrypted) {
    state.messages.push(tab);
  }

  update(storage);
}

storage.init().then(init);
