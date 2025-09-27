import { BrowserMultiFormatReader } from "@zxing/browser";
import type { Result } from "@zxing/library";

type StatusKind = "ok" | "warn" | "err" | "info";

type ValidationResponse = {
    codigo: string;
    estado: "OK" | "YA_USADA" | "NO_ENCONTRADA" | "ERROR";
    mensaje: string;
    data?: any;
};

type ScannerControls = { stop: () => void };

type ScanRequest = {
    code: string;
    operatorId: number;
    validateOnly: boolean;
};

type ScanResponse = {
    codigo: number;
    mensaje: string;
    code: string;
    estado: boolean;
    fechaUso: string | null;
    evento: string;
    fechaEvento: string;
    titular: string;
};

// Utilidad simple para throttling de re-lecturas del mismo código
const makeScanMemory = (ttlMs = 4000) => {
    const last = new Map<string, number>();
    return {
        seenRecently: (value: string) => {
            const now = Date.now();
            const t = last.get(value) ?? 0;
            if (now - t < ttlMs) return true;
            last.set(value, now);
            return false;
        },
        clear: () => last.clear(),
    };
};

const escapeHtml = (s: string) =>
    s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

const setStatus = (el: HTMLElement, kind: StatusKind, msg: string) => {
    el.className = `status badge ${kind === "ok" ? "ok" : kind === "err" ? "err" : "info"}`;
    el.textContent = msg;
};

const chooseBackCamera = (devices: MediaDeviceInfo[]) => {
    // Elige la trasera si el label lo sugiere; si no, la primera
    const lower = (s: string) => (s || "").toLowerCase();
    return (
        devices.find((d) => /back|trasera|rear|facing back/.test(lower(d.label)))?.deviceId ??
        devices[0]?.deviceId ??
        undefined
    );
};

const explain = (e: any) => {
    const n = e?.name || "";
    if (n === "NotAllowedError" || n === "SecurityError")
        return "Permiso denegado o contexto no seguro (usa https o localhost).";
    if (n === "NotFoundError")
        return "No se encontró una cámara disponible.";
    if (n === "NotReadableError")
        return "La cámara está siendo usada por otra aplicación.";
    if (n === "OverconstrainedError")
        return "El deviceId/constraint no coincide con ninguna cámara.";
    return e?.message || "Error desconocido al iniciar la cámara.";
};

function setCameraVisible(show: boolean, videoEl: HTMLVideoElement) {
    // Oculta solo el <video>; puedes ocultar el card contenedor si prefieres
    videoEl.style.display = show ? "" : "none";
}

export function setupQRScanner(root: Document | HTMLElement = document) {
    const $ = <T extends Element>(sel: string) => (root as Document).querySelector(sel) as T;

    const video = $("#video") as HTMLVideoElement;
    const deviceSelect = $("#deviceSelect") as HTMLSelectElement;
    const torchBtn = $("#torchBtn") as HTMLButtonElement;
    const startBtn = $("#startBtn") as HTMLButtonElement;
    const stopBtn = $("#stopBtn") as HTMLButtonElement;
    const statusEl = $("#status") as HTMLElement;
    const detailsEl = $("#details") as HTMLElement;
    const confirmPanel = document.querySelector('#confirmPanel') as HTMLDivElement;
    const confirmInfo = document.querySelector('#confirmInfo') as HTMLDivElement;
    const btnApprove = document.querySelector('#btnApprove') as HTMLButtonElement;
    const btnDeny = document.querySelector('#btnDeny') as HTMLButtonElement;
    const btnClear = document.querySelector('#btnClear') as HTMLButtonElement;

    const beep = new Audio("/beep.mp3");
    const reader = new BrowserMultiFormatReader();
    const memory = makeScanMemory(4000);

    let controls: ScannerControls | null = null;
    let currentStream: MediaStream | null = null;
    let onStop: (() => void) | null = null;
    let aborter: AbortController | null = null;

    const pauseAndHideCamera = async () => {
        // Pausa el lector y apaga la cámara
        aborter?.abort();
        aborter = null;

        controls?.stop();
        controls = null;

        currentStream?.getTracks().forEach(t => t.stop());
        currentStream = null;

        if (video) video.srcObject = null;

        setCameraVisible(false, video);
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus(statusEl, "info", "Cámara en pausa.");
    };

    const showCameraAndRestart = async () => {
        setCameraVisible(true, video);
        await start(); // reanuda el lector
    };


    // ---- Helpers de UI ----
    const showDetails = (html: string) => (detailsEl.innerHTML = html);
    const clearDetails = () => (detailsEl.innerHTML = "");

    // ---- Torch ----
    const toggleTorch = async () => {
        const track = currentStream?.getVideoTracks()[0];
        if (!track) return;
        // @ts-ignore experimental API
        const capabilities = track.getCapabilities?.();
        if (!capabilities || !("torch" in capabilities)) {
            setStatus(statusEl, "warn", "La linterna no está soportada.");
            return;
        }
        // @ts-ignore
        const settings = track.getSettings?.();
        const isOn = settings?.torch === true;
        try {
            // @ts-ignore
            await track.applyConstraints({ advanced: [{ torch: !isOn }] });
        } catch {
            setStatus(statusEl, "warn", "No se pudo alternar la linterna.");
        }
    };

    // ---- Devices ----
    const listDevices = async () => {
        try {
            // 1) Pide permiso rápido para que aparezcan los labels
            const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            tmp.getTracks().forEach(t => t.stop());

            // 2) Lista y llena el select
            const devices = await BrowserMultiFormatReader.listVideoInputDevices();
            console.table(devices.map(d => ({ label: d.label, id: d.deviceId })));

            deviceSelect.innerHTML = "";
            devices.forEach((d, i) => {
                const opt = document.createElement("option");
                opt.value = d.deviceId;
                opt.textContent = d.label || `Cámara ${i + 1}`;
                deviceSelect.appendChild(opt);
            });

            if (devices.length === 0) {
                setStatus(statusEl, "err", "No se encontraron cámaras.");
                return;
            }

            // 3) Preselecciona trasera si existe; si no, deja la primera
            const preferred = chooseBackCamera(devices) ?? devices[0].deviceId;
            deviceSelect.value = preferred;
        } catch (e) {
            setStatus(statusEl, "err", "No fue posible listar cámaras. ¿Permisos denegados?");
        }
    };

    // ---- Validación contra API ----
    async function postScan(body: ScanRequest, signal?: AbortSignal): Promise<ScanResponse> {
        const resp = await fetch('https://kombat-fight.up.railway.app/api/boletas/scan', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': '1',
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`HTTP ${resp.status} - ${txt}`);
        }
        return resp.json();
    }

    if (!btnClear) {
        console.warn('#btnClear no encontrado; revisa el HTML');
    }

    btnClear.onclick = async () => {
        hideConfirm();
        clearDetails();
        setStatus(statusEl, "info", "Listo");
    };

    const validateCode = async (code: string) => {
        setStatus(statusEl, "info", "Validando boleta...");
        hideConfirm();
        clearDetails();

        try {
            const data = await postScan({ code, operatorId: 1, validateOnly: true }, aborter?.signal);

            if (data.codigo === 0 && data.estado) {
                // Mostrar detalles y panel de confirmación
                setStatus(statusEl, "ok", "✅ Válida. Confirma ingreso.");
                detailsEl.innerHTML = `<div class="card mt">
                    <div class="row"><strong>Evento:</strong>&nbsp;${escapeHtml(data.evento)}</div>
                    <div class="row"><strong>Fecha evento:</strong>&nbsp;${escapeHtml(data.fechaEvento)}</div>
                    <div class="row"><strong>Titular:</strong>&nbsp;${escapeHtml(data.titular)}</div>
                    <div class="row"><strong>Código:</strong>&nbsp;${escapeHtml(data.code)}</div>
                    <div class="row"><strong>Mensaje:</strong>&nbsp;${escapeHtml(data.mensaje)}</div>
                </div>`;

                beep?.play().catch(() => { });

                // ⏸️ Pausa lector y oculta la cámara mientras se decide
                await pauseAndHideCamera();

                showConfirm(`<div>¿Aprobar ingreso para <strong>${escapeHtml(data.titular)}</strong> al evento <strong>${escapeHtml(data.evento)}</strong>?</div>`);

                // Wire temporal para este código específico
                btnApprove.onclick = async () => {
                    try {
                        btnApprove.disabled = true; btnDeny.disabled = true;
                        setStatus(statusEl, "info", "Aplicando ingreso...");
                        const applied = await postScan({ code, operatorId: 1, validateOnly: false }, aborter?.signal);
                        if (applied.codigo === 0 && applied.estado) {
                            setStatus(statusEl, "ok", "🎟️ Boleta usada correctamente.");
                            detailsEl.innerHTML = `<div class="card mt">
                                <div class="row"><strong>Mensaje:</strong>&nbsp;${escapeHtml(applied.mensaje)}</div>
                                <div class="row"><strong>Fecha uso:</strong>&nbsp;${escapeHtml(applied.fechaUso ?? "")}</div>
                                </div>`;
                        }
                        else {
                            setStatus(statusEl, "err", `⛔ No se pudo usar: ${escapeHtml(applied.mensaje)}`);
                        }
                    } catch (e: any) {
                        if (e?.name !== 'AbortError') setStatus(statusEl, "err", `Error al aplicar: ${e?.message ?? ''}`);
                    } finally {
                        hideConfirm();
                        btnApprove.disabled = false; btnDeny.disabled = false;
                        await showCameraAndRestart(); // 🔁 vuelve a mostrar y reanudar
                    }
                };

                btnDeny.onclick = async () => {
                    hideConfirm();
                    setStatus(statusEl, "info", "Ingreso denegado (no se consumió la boleta).");
                    await showCameraAndRestart(); // 🔁 vuelve a mostrar y reanudar
                };
            }
            else {
                // No válida: pinta error
                setStatus(statusEl, "err", `⛔ No válida: ${escapeHtml(data.mensaje)}`);
                detailsEl.innerHTML = `<div class="badge err">Código: ${escapeHtml(data.code)}</div>
                ${data.fechaUso ? `<div class="small mt">Usada: ${escapeHtml(data.fechaUso)}</div>` : ""}`;
                hideConfirm();
            }
        }
        catch (e: any) {
            if (e?.name === "AbortError") return; // se detuvo el escáner
            setStatus(statusEl, "err", `Falló la conexión a la API. ${e?.message ?? ""}`);
            detailsEl.innerHTML = "";
            hideConfirm();
        }
    };

    // ---- Scanner ----
    const start = async () => {
        if (controls) return;
        aborter = new AbortController();
        setStatus(statusEl, "info", "Iniciando cámara...");

        const selectedId = deviceSelect.value || undefined;

        try {
            const resultCb = async (result: Result | undefined, _error: unknown, ctrls: ScannerControls) => {
                controls = ctrls;
                const value = result?.getText?.();
                if (!value) return;
                if (memory.seenRecently(value)) return;
                beep?.play().catch(() => { });
                await validateCode(value);
            };

            controls = await reader.decodeFromVideoDevice(selectedId, video, resultCb);
            currentStream = (video.srcObject as MediaStream) ?? null;

            setStatus(statusEl, "ok", "Escaneando... apunta el QR");
            startBtn.disabled = true;
            stopBtn.disabled = false;

            onStop = () => {
                // Nada extra por ahora
            };
        } catch (e: any) {
            console.error("Camera start error:", e?.name, e?.message, e);
            setStatus(statusEl, "err", `No se pudo iniciar la cámara. ${explain(e)}`);
        }
    };

    const stop = async () => {
        aborter?.abort();
        aborter = null;

        if (controls) {
            controls.stop();
            controls = null;
        }
        if (currentStream) {
            currentStream.getTracks().forEach((t) => t.stop());
            currentStream = null;
        }
        if (video) video.srcObject = null;

        onStop?.();
        onStop = null;

        setStatus(statusEl, "info", "Cámara detenida.");
        startBtn.disabled = false;
        stopBtn.disabled = true;
    };

    const restartWithSelected = async () => {
        await stop();
        await start();
    };

    async function applyEntry(code: string) {
        try {
            btnApprove.disabled = true;
            btnDeny.disabled = true;
            setStatus(statusEl, "info", "Aplicando ingreso...");

            const data = await postScan({ code, operatorId: 1, validateOnly: false }, aborter?.signal);
            debugger;
            if (data.codigo === 0 && data.estado) {
                setStatus(statusEl, "ok", "🎟️ Boleta usada correctamente.");
                detailsEl.innerHTML = `<div class="card mt">
                <div class="row"><strong>Mensaje:</strong>&nbsp;${escapeHtml(data.mensaje)}</div>
                <div class="row"><strong>Evento:</strong>&nbsp;${escapeHtml(data.evento)}</div>
                <div class="row"><strong>Titular:</strong>&nbsp;${escapeHtml(data.titular)}</div>
                <div class="row"><strong>Fecha uso:</strong>&nbsp;${escapeHtml(data.fechaUso ?? "")}</div>
                <div class="row"><strong>Código:</strong>&nbsp;${escapeHtml(data.code)}</div>
                </div>`;
            } else {
                setStatus(statusEl, "err", `⛔ No se pudo usar la boleta: ${escapeHtml(data.mensaje)}`);
            }
        } catch (e: any) {
            if (e?.name === "AbortError") return;
            setStatus(statusEl, "err", `Error al aplicar ingreso: ${e?.message ?? ""}`);
        } finally {
            hideConfirm();
            btnApprove.disabled = false;
            btnDeny.disabled = false;
        }
    }
    function showConfirm(html: string) {
        confirmInfo.innerHTML = html;
        confirmPanel.style.display = '';
    }
    function hideConfirm() {
        confirmPanel.style.display = 'none';
        confirmInfo.innerHTML = '';
    }

    // ---- Wire events ----
    startBtn.addEventListener("click", start);
    stopBtn.addEventListener("click", stop);
    deviceSelect.addEventListener("change", restartWithSelected);
    torchBtn.addEventListener("click", toggleTorch);

    // Primera carga de devices
    // Nota: En algunos navegadores necesitas haber llamado a getUserMedia antes
    // para que aparezcan labels. Con esta implementación funciona igual.
    listDevices();

    // Expone un pequeño API para controlar desde fuera si quieres
    return {
        start,
        stop,
        restartWithSelected,
        toggleTorch,
        refreshDevices: listDevices,
        destroy: async () => {
            startBtn.removeEventListener("click", start);
            stopBtn.removeEventListener("click", stop);
            deviceSelect.removeEventListener("change", restartWithSelected);
            torchBtn.removeEventListener("click", toggleTorch);
            memory.clear();
            await stop();
        },
    };
}
