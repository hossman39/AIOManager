import { StateStorage, createJSONStorage } from 'zustand/middleware'

export const safeLocalStorage: StateStorage = {
    getItem: (name: string): string | null => {
        try {
            const value = localStorage.getItem(name)
            // Trap the specific corruption
            if (value && (value.includes('[object Object]') || value === '[object Object]')) {
                console.warn(`[SafeStorage] Corrupted key detected: ${name}. Wiping.`)
                localStorage.removeItem(name)
                return null
            }
            return value
        } catch (e) {
            console.error(`[SafeStorage] Failed to read ${name}`, e)
            return null
        }
    },
    setItem: (name: string, value: string): void => {
        // Prevent writing corruption
        if (value.includes('[object Object]')) {
            console.warn(`[SafeStorage] Prevented writing corrupted data to ${name}`)
            return
        }
        localStorage.setItem(name, value)
    },
    removeItem: (name: string): void => {
        localStorage.removeItem(name)
    }
}

export const createSafeStorage = () => createJSONStorage(() => safeLocalStorage)

// Persist the manager identity across visits. Keep its reusable password scoped
// to the unlocked browser tab, alongside the existing session encryption key.
export const syncStorage = () => createJSONStorage(() => ({
    getItem(name: string) {
        const value = localStorage.getItem(name)
        if (!value) return null
        const record = JSON.parse(value)
        const auth = record.state?.auth
        if (!auth) return value
        const session = sessionStorage.getItem('stremio-manager:session-key')
        if (auth.password) {
            if (session) sessionStorage.setItem(name, JSON.stringify([auth.id, auth.password]))
            auth.password = ''
            localStorage.setItem(name, JSON.stringify(record))
        }
        const saved = JSON.parse(sessionStorage.getItem(name) || 'null')
        auth.password = session && saved?.[0] === auth.id ? saved[1] : ''
        return JSON.stringify(record)
    },
    setItem(name: string, value: string) {
        const record = JSON.parse(value)
        const auth = record.state.auth
        if (auth.password) sessionStorage.setItem(name, JSON.stringify([auth.id, auth.password]))
        else sessionStorage.removeItem(name)
        auth.password = ''
        localStorage.setItem(name, JSON.stringify(record))
    },
    removeItem(name: string) {
        sessionStorage.removeItem(name)
        localStorage.removeItem(name)
    },
}))
