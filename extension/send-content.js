const urlParams = new URLSearchParams(window.location.search);
const friendId = urlParams.get("t");

if (friendId) {
  requestFriendship(friendId).catch(console.error);
}

async function requestFriendship(friendId) {
  const user = await browser.runtime.sendMessage({
    type: "friend-request",
    friendId,
  });
}
