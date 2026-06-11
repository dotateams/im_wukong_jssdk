export default class StorageService {
  static shared = new StorageService()
  setItem(key: string, value: string) {
    if (typeof localStorage === "undefined") {
      return
    }
    localStorage.setItem(key, value)
  }
  getItem(key: string): string | null {
    if (typeof localStorage === "undefined") {
      return null
    }
    return localStorage.getItem(key)
  }
  removeItem(key: string) {
    if (typeof localStorage === "undefined") {
      return
    }
    localStorage.removeItem(key)
  }
}
