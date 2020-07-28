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

const CLONABLE = [
  "userId",
  "status",
  "friends",
  "displayName",
  "registering",
  "messages",
  "connection_retry",
];

async function update(storage) {
  await storage.save();
  const { state } = storage;
  const { messages } = state;

  const clonable = {};
  for (let k of CLONABLE) {
    clonable[k] = state[k];
  }

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
    state: clonable,
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
      case "user-info": {
        const { user } = json;
        const friend = state.friends.find((friend) => friend.id === user.id);
        user.isFriend = !!friend;
        user.isYou = user.id === state.userId;
        state.pendingUserInfo[user.id](user);
        state.pendingUserInfo[user.id] = null;
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
    state.ws = null;
    update(storage);

    const delay = Math.pow(5, state.connection_retry);
    console.log(`Reconnecting in ${delay}s...`);
    setTimeout(connect, delay * 1000);
  });

  ws.addEventListener("error", (event) => {
    console.log("Error, closing websocket...");
    ws.close();
  });

  state.ws = ws;
}

function validateUuid(uuid) {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return re.test(uuid);
}

// This API is available from content scripts
const CONTENT_API = {
  "friend-request": async (sender, message, storage) => {
    const { friendId } = message;
    if (!validateUuid(friendId)) {
      throw new Error(`Illegal friendId: ${friendId}`);
    }
    const { tab } = sender;
    browser.tabs.update(tab.id, {
      url: `/add-friend.html?t=${friendId}`,
      loadReplace: true,
    });
  },
};

// This API is available from the popups and extension pages
const PRIVILEGED_API = {
  "user-info": async (sender, message, storage) => {
    const { userId } = message;
    const { state } = storage;
    if (!validateUuid(userId)) {
      throw new Error(`Illegal friendId: ${userId}`);
    }
    const userInfo = new Promise((resolve) => {
      state.pendingUserInfo[userId] = resolve;
    });
    send(state.ws, { type: "user-info", userId });
    return userInfo;
  },
  "add-friend": async (sender, message, storage) => {
    const { friendId } = message;
    if (!validateUuid(friendId)) {
      throw new Error(`Illegal friendId: ${friendId}`);
    }
    send(storage.state.ws, { type: "add-friend", friendId });
  },
  register: async (sender, message, storage) => {
    const { state } = storage;
    state.registering = true;
    update(storage);
    register(state.ws, storage, message.displayName);
  },
  "get-state": async (sender, message, storage) => {
    return Promise.resolve(JSON.parse(JSON.stringify(storage.state)));
  },
  "send-tab": async (sender, message, storage) => {
    const { friendId, tab } = message;
    const { state } = storage;
    const friend = state.friends.find((friend) => friend.id === friendId);
    const encrypted = await encryptMessage(tab, friend);
    send(state.ws, {
      type: "send-tab",
      friendId: friend.id,
      tab: encrypted,
    });
  },
};

async function init() {
  await connect();

  const { state } = storage;
  console.log(state);

  browser.runtime.onMessage.addListener((message, sender) => {
    const { type } = message;
    if (!type) {
      console.error("Missing type.");
      return false;
    }

    if (
      (sender.frameId === 0 || sender.frameId === undefined) &&
      sender.url.startsWith(browser.runtime.getURL(""))
    ) {
      if (type in PRIVILEGED_API) {
        return PRIVILEGED_API[type](sender, message, storage);
      }
    } else {
      if (type in CONTENT_API) {
        return CONTENT_API[type](sender, message, storage);
      }
    }

    return false;
  });

  const openTabs = () => {
    for (const tab of state.messages) {
      browser.tabs.create({
        url: tab,
        active: true,
      });
    }

    state.messages = [];
    update(storage);
  };

  // Open tabs when the user clicks on the browser action
  // icon or on the notification
  browser.browserAction.onClicked.addListener(openTabs);
  browser.notifications.onClicked.addListener(openTabs);

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

  const messageIds = messages.map((m) => m.id);
  send(state.ws, { type: "acknowledge-message", messageIds });

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
