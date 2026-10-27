import { fetchAsBase64 } from "../utils";

/**
 * Draws numbered red boxes on a copy of the page. Vision models are much more
 * reliable at returning one translation per box when the box number is visible
 * in the image, instead of relying on a separate text list alone.
 */
export async function drawNumberedBboxes(
  imageSrc: string,
  bboxes: Bbox[],
  maxWidth = 2048,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      let scale = 1;
      if (img.width > maxWidth) scale = maxWidth / img.width;

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("تعذّر إنشاء سياق الرسم"));
        return;
      }

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.textBaseline = "top";

      bboxes.forEach((box, index) => {
        const x1 = box.x1 * scale;
        const y1 = box.y1 * scale;
        const w = (box.x2 - box.x1) * scale;
        const h = (box.y2 - box.y1) * scale;
        const label = String(index + 1);

        ctx.lineWidth = Math.max(2, 4 * scale);
        ctx.strokeStyle = "#ef4444";
        ctx.strokeRect(x1, y1, w, h);

        const fontSize = Math.max(16, Math.floor(30 * scale));
        ctx.font = `700 ${fontSize}px sans-serif`;
        const metrics = ctx.measureText(label);
        const labelW = metrics.width + 12 * scale;
        const labelH = Math.max(20, 38 * scale);
        let labelY = y1 - labelH;
        if (labelY < 0) {
          // Keep the number off the original text when the box touches the
          // top edge; put it just below the box instead.
          labelY = Math.min(canvas.height - labelH, y1 + h + 2);
        }

        ctx.fillStyle = "#ef4444";
        ctx.fillRect(x1, labelY, labelW, labelH);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, x1 + 6 * scale, labelY + 4 * scale);
      });

      resolve(canvas.toDataURL("image/jpeg", 0.95));
    };

    img.onerror = () => reject(new Error("تعذّر تحميل الصورة لرسم الصناديق"));
    if (imageSrc.startsWith("data:")) {
      img.src = imageSrc;
      return;
    }
    fetchAsBase64(imageSrc).then(
      (base64) => (img.src = base64),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
