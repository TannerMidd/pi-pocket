// Model favorites belong to this person in this browser, independently of subagent permissions.
import { store } from "./store.js";

const key = () => `pocket.modelFavorites.${store.state.me?.id ?? ""}`;

export function favoriteModels() {
    try {
        const saved = JSON.parse(localStorage.getItem(key()) ?? "[]");

        return Array.isArray(saved) ? saved.filter((spec) => typeof spec === "string") : [];
    } catch {
        return [];
    }
}

export function setModelFavorite(spec, starred) {
    const favorites = new Set(favoriteModels());

    if (starred) {
        favorites.add(spec);
    } else {
        favorites.delete(spec);
    }

    localStorage.setItem(key(), JSON.stringify([...favorites]));
    store.set({});
}
