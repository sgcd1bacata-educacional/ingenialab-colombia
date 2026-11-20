// Ejemplo para conectar el botón "Acceso completo Beta 1" de index.html.
// No contiene llaves privadas ni secretos. La URL del Worker se completa
// después del despliegue en Cloudflare.

const BETA1_WORKER_URL = "https://ingenialab-beta1-access.REEMPLAZAR.workers.dev";
const BETA1_SESSION_KEY = "ingenialab.beta1.pending";

export async function beginDrumStudioBeta1Checkout(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
    throw new Error("Escribe un correo electrónico válido.");
  }

  if (BETA1_WORKER_URL.includes("REEMPLAZAR")) {
    throw new Error("El servicio de pago todavía no está configurado.");
  }

  const response = await fetch(BETA1_WORKER_URL + "/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: normalizedEmail }),
    cache: "no-store",
    referrerPolicy: "no-referrer"
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || "No fue posible iniciar el pago.");
  }

  if (
    typeof result.reference !== "string" ||
    typeof result.accessToken !== "string" ||
    typeof result.checkoutUrl !== "string" ||
    !result.checkoutUrl.startsWith("https://checkout.wompi.co/p/")
  ) {
    throw new Error("El servicio devolvió una respuesta de pago incompleta.");
  }

  // Se conserva solo en esta pestaña para recuperarlo después de la redirección.
  // No poner el token en la URL, en analytics, en logs ni en el HTML visible.
  sessionStorage.setItem(BETA1_SESSION_KEY, JSON.stringify({
    reference: result.reference,
    accessToken: result.accessToken
  }));

  window.location.assign(result.checkoutUrl);
}
