export class StateStorage {
    async init() {
        const storage = await browser.storage.local.get('state');

        if (storage.state) {
            const state = JSON.parse(storage.state);
            if (state.publicKey && state.privateKey) {
                state.publicKey = await crypto.subtle.importKey(
                    "jwk",
                    state.publicKey,
                    { name: "RSA-OAEP", hash: "SHA-256" },
                    true,
                    ["encrypt"]);
                state.privateKey = await crypto.subtle.importKey(
                    "jwk",
                    state.privateKey,
                    { name: "RSA-OAEP", hash: "SHA-256" },
                    true,
                    ["decrypt"]);
            }

            this.state = state;
        } else {
            // Initialize
            this.state = {
                userId: "",
                status: "not-connected",
                friends: [],
                displayName: "",
                privateKey: null,
                publicKey: null,
            };
        }
    }

    async save() {
        const { state } = this;

        let publicKey = null;
        let privateKey = null;
        if (state.publicKey && state.privateKey) {
            publicKey = await crypto.subtle.exportKey(
                "jwk", state.publicKey);
            privateKey = await crypto.subtle.exportKey(
                "jwk", state.privateKey);
        }

        const exportedState = {
            ... state,
            privateKey,
            publicKey,
            // Don't save friends
            friends: [],
            status: "not-connected",
            ws: null,
        };

        browser.storage.local.set({ state: JSON.stringify(exportedState) });
    }
}
