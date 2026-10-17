// QA fixture only: requires explicitly approved npm install.
import { z } from 'zod';
export async function run(input) {
  const spec = z.object({ label: z.string().max(80) });
  return spec.parse(input);
}
