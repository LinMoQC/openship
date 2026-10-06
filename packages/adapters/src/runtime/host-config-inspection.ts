import type { ExecOnly } from "../types";
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Return content hashes only. This never returns configuration or credentials,
 * and symlinks cannot expand the explicitly bound configuration directory. */
export async function inspectHostConfiguration(executor: ExecOnly, root: string, files: string[]): Promise<Record<string, string>> {
  if (!root.startsWith('/') || files.length > 128 || files.some(file => !file || file.startsWith('/') || file.split('/').includes('..') || file.length > 1024)) throw new Error("Invalid host configuration scope");
  const script = `import os,sys,json,hashlib
root,files=json.loads(sys.argv[1])
if os.path.realpath(root)!=root: raise RuntimeError('Configuration root is not canonical')
result={}
for name in files:
 path=os.path.realpath(os.path.join(root,name))
 if not path.startswith(root+'/') or not os.path.isfile(path) or os.path.getsize(path)>268435456: raise RuntimeError('Configuration file is outside the bound directory or unavailable')
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1048576),b''): h.update(chunk)
 result[name]=h.hexdigest()
print(json.dumps(result))`;
  const output = await executor.exec(`python3 -c ${quote(script)} ${quote(JSON.stringify([root, files]))}`, { timeout: 15_000 });
  const hashes: Record<string, unknown> = JSON.parse(output);
  if (Object.keys(hashes).length !== files.length || files.some(file => typeof hashes[file] !== 'string' || !/^[a-f0-9]{64}$/.test(hashes[file] as string))) throw new Error("Host configuration inspection returned invalid checksums");
  return hashes as Record<string, string>;
}
