import { AnnouncerProvider } from "@/a11y/Announcer";
import { App } from "@/components/App";

export default function Home() {
  return (
    <AnnouncerProvider>
      <App />
    </AnnouncerProvider>
  );
}
