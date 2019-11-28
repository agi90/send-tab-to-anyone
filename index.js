"use strict";

require('dotenv').config();

const DOMAIN = "sferro.dev";
const PORT = process.env.PORT || 5000;
const DB_URL = process.env.MONGODB_URI || "mongodb://localhost:27017";

const MongoClient = require("mongodb").MongoClient;
const uuid = require("uuid/v4")
const WebSocket = require("ws");
const mongoose = require("mongoose");
const fs = require("fs");

class UserDatabase {
    constructor(url) {
        mongoose.connect(url, {useNewUrlParser: true});

        const db = mongoose.connection;
        db.on("error", console.error.bind(console, "connection error:"));
        db.once("open", function() {
            console.log("connection open");
        });

        const userSchema = new mongoose.Schema({
            displayName: String,
            id: { type: String, index: { unique: true } },
            friends: [String],
            messages: [mongoose.Mixed],
            publicKey: {
                alg: String,
                e: String,
                ext: Boolean,
                key_ops: [String],
                kty: String,
                n: String,
            },
        });

        userSchema.query.byId = function(id) {
            return this.where({ id });
        };

        this.User = mongoose.model("User", userSchema);
    }

    async byId(userId) {
        return this.User.findOne().byId(userId).exec();
    }

    async create(data) {
        const { User } = this;
        const user = new User(data);
        return user.save();
    }
}

const userDb = new UserDatabase(DB_URL);

const wss = new WebSocket.Server({
  port: PORT,
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

const connections = {};

function send(ws, data) {
    ws.send(JSON.stringify(data));
}

async function sendFriends(user) {
    const ws = connections[user.id];
    if (!ws) {
        // User is not connected
        return;
    }

    const result = [];

    const friends =
        await Promise.all(user.friends.map(id => userDb.byId(id)));
    for (const friend of friends) {
        result.push({
            id: friend.id,
            displayName: friend.displayName,
            publicKey: friend.publicKey,
        });
    }

    send(ws, {
        type: "friends",
        friends: result,
    });
}

const API = {
    "register": async (json, state) => {
        const { displayName, publicKey } = json;

        const userId = uuid();

        const user = await userDb.create({
            id: userId,
            messages: [],
            friends: [],
            displayName,
            publicKey,
        });

        connections[userId] = state.ws;

        state.userId = userId;

        send(state.ws, { type: "user", userId, displayName });
    },

    "login": async (json, state) => {
        const { userId } = json;
        const user = await userDb.byId(userId);

        if (!user) {
            console.error(`Unknown user ${userId}`);
            return;
        }

        state.userId = userId;
        connections[userId] = state.ws;

        const { displayName } = user;
        send(state.ws, { type: "user", userId, displayName });

        let message = user.messages.shift();
        while (message) {
            send(state.ws, message);
            message = user.messages.shift();
        }

        user.markModified('messages');
        await user.save();
    },

    "add-friend": async (json, state) => {
        const { friendId } = json;
        const { userId } = state;

        if (friendId === userId) {
            console.error(`Cannot add yourself as friend.`);
            return;
        }

        const friend = await userDb.byId(friendId);
        if (!friend) {
            console.error(`Uknown user: ${friendId}`);
            return;
        }

        const user = await userDb.byId(userId);

        if (user.friends.indexOf(friendId) === -1) {
            user.friends.push(friendId);
        }

        if (friend.friends.indexOf(userId) === -1) {
            friend.friends.push(userId);
        }

        await Promise.all([
            user.save(),
            friend.save()
        ]);

        await Promise.all([
            sendFriends(user),
            sendFriends(friend)
        ]);
    },

    "friends": async (json, state) => {
        const user = await userDb.byId(json.userId);
        await sendFriends(user);
    },

    "send-tab": async (json, state) => {
        const { friendId, tab } = json;
        const friend = await userDb.byId(friendId);
        if (!friend) {
            console.error(`Uknown friend: ${friendId}`);
            return;
        }

        const message = {
            type: "receive-tab",
            tab,
        };

        const ws = connections[friendId];
        // If the user is connected, send immediately
        if (ws) {
            send(ws, message);
        } else {
            friend.messages.push(message);
            friend.markModified('messages');
            await friend.save();
        }
    },
};

wss.on("connection", ws => {
    const state = {
        userId: "",
        ws,
    };

    ws.on("error", data => {
        connections[state.userId] = null;
    });

    ws.on("close", data => {
        if (connections[state.userId]) {
            connections[state.userId] = null;
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
