import StorageService from "../storage/StorageService"

export function generateUUID() {
  let result = ""
  for (let i = 0; i < 16; i++) {
    result += Math.floor(Math.random() * 10).toString()
  }
  return result
}
// export function generateUUID() {
//   return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
//     const r = Math.floor(Math.random() * 16)
//     const v = c === "x" ? r : (r % 4) + 8
//     return v.toString(16)
//   })
  export function getDeviceIdFromStorage() {
    let deviceId = StorageService.shared.getItem("deviceId")
    if (!deviceId || deviceId === "") {
      deviceId = generateUUID().toString()
      StorageService.shared.setItem("deviceId", deviceId)
    }
    return deviceId
  }

  export function getOSAndVersion() {
    if (typeof navigator === "undefined" || !navigator.userAgent) {
      return "Unknown OS and version"
    }
    const userAgent = navigator.userAgent
    if (/Windows NT (\d+\.\d+)/i.test(userAgent)) {
      const match = userAgent.match(/Windows NT (\d+\.\d+)/i)
      const version = match && match[1]
      return `Windows ${version}`
    }
    if (/Mac OS X (\d+_\d+(_\d+)?)/i.test(userAgent)) {
      const match = userAgent.match(/Mac OS X (\d+_\d+(_\d+)?)/i)
      const version = match && match[1] ? match[1].replace(/_/g, ".") : ""
      return `MacOS ${version}`
    }
    if (/Android (\d+(\.\d+)?)/i.test(userAgent)) {
      const match = userAgent.match(/Android (\d+(\.\d+)?)/i)
      const version = match && match[1]
      return `Android ${version}`
    }
    if (/CPU (iPhone )?OS (\d+_\d+(_\d+)?)/i.test(userAgent)) {
      const match = userAgent.match(/CPU (iPhone )?OS (\d+_\d+(_\d+)?)/i)
      const version = match && match[2] ? match[2].replace(/_/g, ".") : ""
      return `iOS ${version}`
    }
    if (/Linux/i.test(userAgent)) {
      return "Linux (version not available)"
    }
    return "Unknown OS and version"
  }
