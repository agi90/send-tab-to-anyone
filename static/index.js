document.addEventListener("DOMContentLoaded", init);

const CONNECTION_STATUS = {
    "not-connected": "Not Connected",
    "connected": "Connected",
    "error": "Connection Error",
};

function send(ws, data) {
    ws.send(JSON.stringify(data));
}

function addFriend(ws, friendId) {
    send(ws, { type: "add-friend", friendId });
}

function sendMessage(ws, tab, friend) {
    send(ws, { type: "send-tab", friendId: friend.id, tab });
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
            sendMessage(state.ws, tab, friend);
        });
        friendsDiv.appendChild(button);
    }
}

function receiveTab(json, state) {
    const span = document.createElement("span");
    span.innerText = json.tab;

    document.getElementById("received").appendChild(span);
}

function connect(state, userId, displayName) {
    const ws = new WebSocket("ws://127.0.0.1:5000");
    state.ws = ws;

    // Connection opened
    ws.addEventListener('open', event => {
        state.status = "connected";
        state.userId = state.userId || userId;
        state.displayName = state.displayName || displayName;

        if (state.userId) {
            send(ws, { type: "login", userId: state.userId });
            send(ws, { type: "friends", userId: state.userId });
        } else {
            send(ws, { type: "register", displayName });
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

    ws.addEventListener('message', event => {
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
                state.friends = json.friends;
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

function init() {
    const state = {
        userId: "",
        status: "not-connected",
        friends: [],
    };

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
