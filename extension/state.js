const EXPORTED = [
  "userId",
  "displayName",
  "privateKey",
  "publicKey",
  "registering",
  "messages",
];

export class StateStorage {
    emptyStorage() {
        // Initialize
        this.state = {
            userId: "",
            status: "not-connected",
            friends: [],
            displayName: "",
            privateKey: null,
            publicKey: null,
            registering: false,
            messages: [],
            ws: null,
        };
    }

    async init() {
        const storage = await browser.storage.local.get('state');

        if (!storage.state) {
            this.emptyStorage();
            return;
        }

        const state = JSON.parse(storage.state);

        if (!state.publicKey || !state.privateKey) {
            this.emptyStorage();
            return;
        }

        try {
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
        } catch (ex) {
            console.error(ex);
            this.emptyStorage();
            return;
        }

        state.messages = state.messages || [];
        state.friends = [];
        state.status = "not-connected";

        this.state = state;
    }

    export(key) {
        const { state } = this;
        const value = state[key];

        if (!value) {
            return null;
        }

        switch (key) {
            case "publicKey":
            case "privateKey":
                return crypto.subtle.exportKey("jwk", value);

            default:
                return value;
        }
    }

    async save() {
        const exported = await Promise.all(
            EXPORTED.map(async key => [key, await this.export(key)]));
        const exportedState = {};
        for (let [key, value] of exported) {
            exportedState[key] = value;
        }
        browser.storage.local.set({ state: JSON.stringify(exportedState) });
    }
}
