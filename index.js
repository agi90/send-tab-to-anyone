"use strict";

const DOMAIN = 'sferro.dev';

const uuid = require('uuid/v4')
const WebSocket = require("ws");
const port = process.env.PORT || 5000;
const fs = require('fs');

const wss = new WebSocket.Server({
  port,
  perMessageDeflate: {
    zlibDeflateOptions: {
      // See zlib defaults.
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    // Other options settable:
    clientNoContextTakeover: true, // Defaults to negotiated value.
    serverNoContextTakeover: true, // Defaults to negotiated value.
    serverMaxWindowBits: 10, // Defaults to negotiated value.
    // Below options specified as default values.
    concurrencyLimit: 10, // Limits zlib concurrency for perf.
    threshold: 1024 // Size (in bytes) below which messages
    // should not be compressed.
  }
});

function init() {
    let users = {};
    try {
        const json = fs.readFileSync('users.json');
        users = JSON.parse(json);
    } catch (ex) {
        console.error(`Could not read users.json: ${ex}`);
    }

    for (const userId of Object.keys(users)) {
        const user = users[userId];
        user.friends = new Set(user.friends);
    }

    return users;
}

const users = init();

function send(ws, data) {
    ws.send(JSON.stringify(data));
}

function sendFriends(user) {
    const friends = [];
    for (const friendId of user.friends) {
        friends.push({
            id: friendId,
            displayName: users[friendId].displayName,
        });
    }

    send(user.ws, {
        type: "friends",
        friends,
    });
}

function dumpState(users) {
    const state = {};
    for (const userId of Object.keys(users)) {
        const { friends, messages, displayName } = users[userId];
        state[userId] = {
            friends: Array.from(friends), messages, displayName
        };
    }

    fs.writeFile("users.json", JSON.stringify(state), function(err) {
        if (err) {
            return console.log(err);
        }
    });
}

const API = {
    "register": (json, state) => {
        const { displayName } = json;
        const userId = uuid();

        users[userId] = {
            friends: new Set(),
            ws: state.ws,
            messages: [],
            displayName,
        };

        state.userId = userId;

        send(state.ws, { type: "user", userId, displayName });

        dumpState(users);
    },

    "login": (json, state) => {
        const { userId } = json;
        const user = users[userId];

        if (!user) {
            console.error(`Unknown user ${userId}`);
            return;
        }

        state.userId = userId;
        user.ws = state.ws;

        let message = user.messages.shift();
        while (message) {
            send(user.ws, message);
            message = user.messages.shift();
        }

        dumpState(users);
    },

    "add-friend": (json, state) => {
        const { friendId } = json;
        const { userId } = state;

        if (friendId === userId) {
            console.error(`Cannot add yourself as friend.`);
            return;
        }

        const friend = users[friendId];
        if (!friend) {
            console.error(`Uknown user: ${friendId}`);
            return;
        }

        const user = users[userId];

        user.friends.add(friendId);
        friend.friends.add(userId);

        sendFriends(user);

        // If the friend is also connected, notify them
        if (friend.ws) {
            sendFriends(friend);
        }

        dumpState(users);
    },

    "friends": (json, state) => {
        const user = users[state.userId];
        sendFriends(user);
    },

    "send-tab": (json, state) => {
        const friend = users[json.friendId];
        if (!friend) {
            console.error(`Uknown friend: ${json.friendId}`);
            return;
        }

        const message = {
            type: "receive-tab",
            tab: json.tab,
        };

        // If the user is connected, send immediately
        if (friend.ws) {
            send(friend.ws, message);
        } else {
            friend.messages.push(message);
            dumpState(users);
        }
    },
};

wss.on("connection", ws => {
    const state = {
        userId: "",
        ws,
    };

    ws.on("error", data => {
        users[state.userId].ws = null;
    });

    ws.on("close", data => {
        if (users[state.userId]) {
            users[state.userId].ws = null;
        }
    });

    ws.on("message", data => {
        const json = JSON.parse(data);

        const api = API[json.type];
        if (!api) {
            console.error(`Unknown API: ${json.type}`);
            return;
        }

        api(json, state);
    });
});
