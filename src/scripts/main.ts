import { setupQRScanner } from "../components/QRScanner";

window.addEventListener("DOMContentLoaded", () => {
  // @ts-ignore
    window.scanner = setupQRScanner(document);
});
