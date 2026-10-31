import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Question } from "../schema";

// The images attached to questions, one file per question beside the
// incidents: .data/question-images/<incident>/<question>.<ext>. They stay
// out of the incident's JSON, which the page reloads every second while an
// answer streams.

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Read at each call rather than once, so tests can work in a temp directory.
const root = () => path.join(process.cwd(), ".data", "question-images");

function folderFor(incidentId: string): string {
  if (!/^inc_[a-z0-9_]+$/.test(incidentId)) throw new Error(`invalid incident id: ${incidentId}`);
  return path.join(root(), incidentId);
}

function fileFor(incidentId: string, questionId: string, mediaType: string): string {
  if (!/^q_\d+$/.test(questionId)) throw new Error(`invalid question id: ${questionId}`);
  const ext = extensions[mediaType];
  if (!ext) throw new Error(`unsupported image type: ${mediaType}`);
  return path.join(folderFor(incidentId), `${questionId}.${ext}`);
}

export async function saveQuestionImage(
  incidentId: string,
  questionId: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<void> {
  const file = fileFor(incidentId, questionId, mediaType);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

// A question's image, or undefined when it has none or the file is gone.
export async function readQuestionImage(
  incidentId: string,
  question: Pick<Question, "id" | "image">,
): Promise<{ bytes: Buffer; mediaType: string } | undefined> {
  if (!question.image) return undefined;
  const { mediaType } = question.image;
  try {
    return { bytes: await readFile(fileFor(incidentId, question.id, mediaType)), mediaType };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// Every image on an incident, for when the incident itself is removed.
export async function removeQuestionImages(incidentId: string): Promise<void> {
  await rm(folderFor(incidentId), { recursive: true, force: true });
}
