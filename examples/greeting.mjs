export async function run(input) {
  const name = String(input.name ?? 'world').slice(0, 100);
  return { message: `Hello, ${name} from sandboxed Node.js!` };
}
