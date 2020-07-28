import { SHARE_URL, SHARE_URL_DISPLAY } from "./constants.js";

document.addEventListener("DOMContentLoaded", init);

const CONNECTION_STATUS = {
  "not-connected": "Not Connected",
  connected: "",
  error: "Connection Error",
};

async function sendMessage(url, friend) {
  browser.runtime.sendMessage({
    type: "send-tab",
    tab: url,
    friendId: friend.id,
  });
}

async function update(state) {
  document.getElementById("new-user").style.display = "none";
  document.getElementById("existing-user").style.display = "none";
  document.getElementById("invalid").style.display = "none";
  document.getElementById("register").style.display = "none";
  document.getElementById("register-icon").style.display = "none";

  if (!state.userId) {
    if (state.registering) {
      document.getElementById("register-icon").style.display = "inline-block";
    } else {
      document.getElementById("register").style.display = "inline-block";
    }

    document.getElementById("new-user").style.display = "block";
    return;
  }

  const { url } = (
    await browser.tabs.query({
      active: true,
      currentWindow: true,
    })
  )[0];

  if (!url.startsWith("http:") && !url.startsWith("https:")) {
    document.getElementById("invalid").style.display = "block";
    return;
  }

  document.getElementById("existing-user").style.display = "block";

  const connectionStatus = CONNECTION_STATUS[state.status];
  document.getElementById("connection-status").innerText = connectionStatus;

  const userUrl = document.getElementById("user-url");
  userUrl.innerText = SHARE_URL_DISPLAY + state.userId;
  userUrl.href = SHARE_URL + state.userId;

  document.querySelector(".display-name").innerText = state.displayName;
  const friendsDiv = document.getElementById("friends");

  if (state.friends.length === 0) {
    document.querySelector(".send-tab-to-text").style.display = "none";
    document.querySelector(".send-tab-divider").style.display = "none";
    document.getElementById("show-friend-code").style.display = "none";
  }

  friendsDiv.innerHTML = "";
  for (const friend of state.friends) {
    const button = document.createElement("button");
    button.type = "button";
    button.innerText = friend.displayName;
    button.value = friend.id;
    button.classList.add("user-button");
    button.addEventListener("click", async (event) => {
      console.log(url);
      sendMessage(url, friend);
      button.innerText += "✔️";
      button.classList.add("sent");
      button.disabled = true;
    });
    friendsDiv.appendChild(button);
  }
}

async function register(displayName) {
  browser.runtime.sendMessage({
    type: "register",
    displayName,
  });
}

async function init() {
  const state = await browser.runtime.sendMessage({
    type: "get-state",
  });
  console.log(state);
  const { userId } = state;

  update(state);

  document.getElementById("display-name").addEventListener("keyup", (ev) => {
    if (ev.keyCode === 13) {
      // Interpret "enter" as register
      register(ev.target.value);
    }
  });

  document.getElementById("register").addEventListener("click", async (ev) => {
    const displayName = document.getElementById("display-name").value;
    register(displayName);
  });

  document.getElementById("user-url").addEventListener("click", (ev) => {
    ev.preventDefault();
    document.getElementById("copied").innerText = "(copied ✔)";
    navigator.clipboard.writeText(SHARE_URL + userId);
  });

  if (state.friends.length > 0) {
    document.getElementById("friend-code-wrapper").style.display = "none";

    document
      .getElementById("show-friend-code")
      .addEventListener("click", (ev) => {
        document.getElementById("friend-code-wrapper").style.display = "block";
        document.getElementById("show-friend-code").style.display = "none";
      });
  }
}

browser.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "update": {
      update(message.state);
      break;
    }
    default: {
      return false;
    }
  }
});
