import { SHARE_URL, SHARE_URL_DISPLAY } from "./constants.js";

const urlParams = new URLSearchParams(window.location.search);
const friendId = urlParams.get("t");

if (friendId) {
  requestFriendship(friendId).catch(console.error);
}

async function requestFriendship(friendId) {
  const user = await browser.runtime.sendMessage({
    type: "user-info",
    userId: friendId,
  });

  document.querySelectorAll(".user-name").forEach((userName) => {
    userName.innerText = user.displayName;
  });

  if (user.isYou) {
    document.getElementById("this-is-you").style.display = "block";
    const userLink = document.getElementById("user-link");
    userLink.href = SHARE_URL + friendId;
    userLink.innerText = SHARE_URL_DISPLAY + friendId;
    return;
  } else if (user.isFriend) {
    document.getElementById("already-friends").style.display = "block";
    return;
  } else {
    document.getElementById("friend-request").style.display = "block";
  }

  document
    .getElementById("cancel-friend-request")
    .addEventListener("click", async () => {
      const current = await browser.tabs.getCurrent();
      browser.tabs.remove(current.id);
    });

  document
    .getElementById("add-friend-button")
    .addEventListener("click", async () => {
      browser.runtime.sendMessage({
        type: "add-friend",
        friendId,
      });
      browser.browserAction.openPopup();
      const current = await browser.tabs.getCurrent();
      browser.tabs.remove(current.id);
    });
}
