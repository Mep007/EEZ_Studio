import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// Never truncate an existing output: some Windows environments reject that open,
// and a failed conversion/write must leave the previous generated file intact.
export async function writeGeneratedOutput(filePath: string, data: string | Buffer) {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    let mode: number | undefined;
    try {
        const stat = await fs.promises.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error(`Refusing to replace non-regular generated output: ${filePath}`);
        }
        if ((await fs.promises.readFile(filePath)).equals(bytes)) return;
        mode = stat.mode;
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }
    const temporary = path.join(path.dirname(filePath), `.eez-${path.basename(filePath)}-${randomUUID()}.tmp`);
    try {
        const handle = await fs.promises.open(temporary, "wx", mode);
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.promises.rename(temporary, filePath);
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
}
