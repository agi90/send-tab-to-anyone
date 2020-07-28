require("dotenv").config();

const DEBUG = process.env.DEBUG || false;
const PORT = process.env.PORT || 5000;
const DB_URL = process.env.MONGODB_URI || "mongodb://localhost:27017";

const express = require("express");
const uuid = require("uuid/v4");
const WebSocket = require("ws");
const mongoose = require("mongoose");

const INDEX = "/static/index.html";

const server = express()
  .get("/index.js", (req, res) =>
    res.sendFile("/static/index.js", { root: __dirname })
  )
  .use((req, res) => res.sendFile(INDEX, { root: __dirname }))
  .listen(PORT, () => console.log(`Listening on ${PORT}`));

class UserDatabase {
  constructor(url) {
    mongoose.connect(url, { useNewUrlParser: true });

    const db = mongoose.connection;
    db.on("error", console.error.bind(console, "connection error:"));
    db.once("open", function () {
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

    userSchema.query.byId = function (id) {
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

const wss = new WebSocket.Server({ server });

const connections = {};

function send(ws, data) {
  if (DEBUG) {
    console.log(`send: ${JSON.stringify(data)}`);
  }
  ws.send(JSON.stringify(data));
}

async function friendList(user) {
  const result = [];

  const friends = await Promise.all(user.friends.map((id) => userDb.byId(id)));
  for (const friend of friends) {
    result.push({
      id: friend.id,
      displayName: friend.displayName,
      publicKey: friend.publicKey,
    });
  }

  return result;
}

async function sendFriends(user) {
  const ws = connections[user.id];
  if (!ws) {
    // User is not connected
    return;
  }

  const friends = await friendList(user);
  send(ws, { type: "friends", friends });
}

const API = {
  register: async (json, state) => {
    const { displayName, publicKey } = json;

    const userId = uuid();

    await userDb.create({
      id: userId,
      messages: [],
      friends: [],
      displayName,
      publicKey,
    });

    connections[userId] = state.ws;

    state.userId = userId;

    send(state.ws, {
      type: "user",
      userId,
      displayName,
      friends: [],
      messages: [],
    });
  },

  login: async (json, state) => {
    const { userId } = json;
    const user = await userDb.byId(userId);

    if (!user) {
      console.error(`Unknown user ${userId}`);
      return;
    }

    state.userId = userId;
    connections[userId] = state.ws;

    const { displayName, messages } = user;

    const friends = await friendList(user);
    send(state.ws, { type: "user", userId, displayName, friends, messages });
  },

  "acknowledge-message": async (json, state) => {
    const { messageIds } = json;
    const { userId } = state;

    const messageIdSet = new Set(messageIds);
    const user = await userDb.byId(userId);

    const messages = [];

    for (let message of user.messages) {
      if (!messageIdSet.has(message.id)) {
        messages.push(message);
      }
    }

    user.messages = messages;
    user.markModified("messages");
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

    await Promise.all([user.save(), friend.save()]);
    await Promise.all([sendFriends(user), sendFriends(friend)]);
  },

  "user-info": async (json, state) => {
    const user = await userDb.byId(json.userId);
    if (!user) {
      // handle error
      console.error(`User not found: ${json.userId}`);
      return;
    }

    send(state.ws, {
      type: "user-info",
      user: {
        displayName: user.displayName,
        id: user.id,
      },
    });
  },

  friends: async (json, state) => {
    const user = await userDb.byId(json.userId);
    if (user) {
      await sendFriends(user);
    }
  },

  ping: async (json, state) => {
    const ws = connections[state.userId];
    if (!ws) {
      // User disconnected before we could respond
      return;
    }
    send(ws, { type: "pong" });
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
      from: state.userId,
      id: uuid(),
      tab,
    };

    friend.messages.push(message);
    friend.markModified("messages");
    await friend.save();

    const ws = connections[friendId];
    // If the user is connected, send immediately
    if (ws) {
      if (DEBUG) {
        console.log(`Sending message: ${JSON.stringify(message)}`);
      }
      send(ws, message);
    }
  },
};

wss.on("connection", (ws) => {
  const state = {
    userId: "",
    ws,
  };

  ws.on("error", (data) => {
    connections[state.userId] = null;
  });

  ws.on("close", (data) => {
    if (connections[state.userId]) {
      connections[state.userId] = null;
    }
  });

  ws.on("message", (data) => {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      console.error(`Could not parse ${data}`);
      return;
    }

    if (!json || !json.type) {
      console.error(`Message does not have a type: ${data}`);
    }

    const api = API[json.type];
    if (!api) {
      console.error(`Unknown API: "${json.type}"`);
      console.error(`Full message: ${data}`);
      return;
    }

    if (DEBUG) {
      console.log(`got: ${data}`);
    }
    api(json, state);
  });
});
