import { notFound } from "next/navigation";
import { ReleasePreview } from "./ReleasePreview";
export default function DevReleasePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ReleasePreview />;
}
