/**
 * Root page — redirects to the upload flow.
 */
import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/upload");
}
