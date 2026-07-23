import {
  BroadcastIcon,
  CursorClickIcon,
  GithubLogoIcon,
  HandWavingIcon,
  LightbulbIcon,
  MicrophoneIcon,
  QrCodeIcon,
  RobotIcon,
  RocketLaunchIcon,
  WallIcon,
} from "@phosphor-icons/react";
import { Body, Button, Caption, Chip, Footer, Heading1, Heading3, Logo } from "./ui";

const GITHUB_URL = "https://github.com/RonTuretzky/vibecode-room";

function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-paper-2 bg-paper-main/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <a href="#top" className="flex items-center gap-3">
          <Logo size={28} />
          <span className="font-parkDisplay text-lg font-bold uppercase tracking-tight text-surface-ink">
            Vibecode Room
          </span>
        </a>
        <nav className="hidden items-center gap-6 md:flex">
          <a href="#how" className="font-parkBody text-surface-ink hover:text-primary-green">
            How it works
          </a>
          <a href="#room" className="font-parkBody text-surface-ink hover:text-primary-green">
            The room
          </a>
          <a href="#run" className="font-parkBody text-surface-ink hover:text-primary-green">
            Run it
          </a>
        </nav>
        <Button
          as="a"
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          leftIcon={<GithubLogoIcon weight="bold" />}
        >
          GitHub
        </Button>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="border-b border-paper-2 bg-paper-main">
      <div className="mx-auto max-w-6xl px-4 pb-20 pt-16 text-center md:pb-28 md:pt-24">
        <div className="mb-8 flex justify-center">
          <Chip>
            <BroadcastIcon weight="bold" className="text-primary-green" />
            A Decentral Park experiment
          </Chip>
        </div>
        <Heading1 className="mx-auto mb-8 max-w-4xl text-surface-ink">
          Talk. The room builds it.
        </Heading1>
        <Body className="mx-auto mb-10 max-w-2xl text-lg text-surface-grey-2">
          Vibersyn is an ambient idea room. People hang out and talk; the room
          listens, detects concrete buildable ideas, grounds each one to the
          exact span of conversation it came from, and hands it to a fleet of
          coding agents. A projector shows the ideas forming — and the apps
          running.
        </Body>
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button as="a" href="#run" rightIcon={<RocketLaunchIcon weight="bold" />}>
            Run the room
          </Button>
          <Button
            as="a"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="light"
            leftIcon={<GithubLogoIcon weight="bold" />}
          >
            Read the source
          </Button>
        </div>
        <Caption className="mt-10 block text-surface-grey">
          Zero hardware required — a laptop, a mic, and a wall to project on.
        </Caption>
      </div>
    </section>
  );
}

const STEPS = [
  {
    icon: <MicrophoneIcon size={28} weight="duotone" />,
    accent: "bg-paper-1 text-primary-green",
    title: "Talk",
    body: "The room transcribes the conversation live. No commands needed — just people riffing. Say “Vibersyn” to open Idea Capture when you want it listening on purpose.",
  },
  {
    icon: <LightbulbIcon size={28} weight="duotone" />,
    accent: "bg-sky-0/40 text-primary-sky",
    title: "Detect",
    body: "Windowed model inference watches the transcript for concrete, buildable ideas — and grounds every one to the span of conversation that sparked it, so nothing is invented from thin air.",
  },
  {
    icon: <RobotIcon size={28} weight="duotone" />,
    accent: "bg-pine-0/40 text-primary-pine",
    title: "Build",
    body: "Accepted ideas spawn a real agent fleet: accept → build → preview. Bubbles on the wall become running apps you can open, steer, or dismiss — by voice, keyboard, or a wave of the hand.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="bg-paper-0 py-20">
      <div className="mx-auto max-w-6xl px-4">
        <Heading3 className="mb-4 text-center text-surface-ink">
          Conversation in, running apps out
        </Heading3>
        <Body className="mx-auto mb-12 max-w-2xl text-center text-surface-grey-2">
          Three moving parts, one loop — running continuously while the room talks.
        </Body>
        <div className="grid gap-6 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <div
              key={step.title}
              className="rounded-2xl border border-paper-2 bg-paper-main p-8"
            >
              <div
                className={`mb-6 inline-flex h-14 w-14 items-center justify-center rounded-xl ${step.accent}`}
              >
                {step.icon}
              </div>
              <div className="mb-2 flex items-baseline gap-3">
                <span className="font-parkDisplay text-sm font-bold text-surface-grey">
                  0{i + 1}
                </span>
                <span className="font-parkDisplay text-2xl font-bold text-surface-ink">
                  {step.title}
                </span>
              </div>
              <Body className="text-surface-grey-2">{step.body}</Body>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    icon: <MicrophoneIcon size={24} weight="bold" />,
    title: "Voice-native",
    body: "“Vibersyn, build it” builds the top idea. “Vibersyn, stop everything” is the emergency stop. The wake word is fuzzy-matched — “viber sin” works too.",
  },
  {
    icon: <QrCodeIcon size={24} weight="bold" />,
    title: "QR phone import",
    body: "Scan a QR on the wall, describe what the fleet should build, optionally point it at a GitHub repo. Every submission spawns a real build project.",
  },
  {
    icon: <RobotIcon size={24} weight="bold" />,
    title: "Auto-Build mode",
    body: "Flip Auto-Build on and the room stops asking: ready ideas go straight to the agent fleet, previews appear on the wall as they come up.",
  },
  {
    icon: <WallIcon size={24} weight="bold" />,
    title: "Two-wall 3D room",
    body: "Both walls render the full 3D room — every idea and every build — each with its own orbiting camera, so the space reads differently from every side.",
  },
  {
    icon: <HandWavingIcon size={24} weight="bold" />,
    title: "Gesture control",
    body: "Optional camera modes: a depth camera (or an old Kinect v2) turns pointing into clicks with a dwell, and MediaPipe hand-pinch steers the 3D camera in mid-air.",
  },
  {
    icon: <CursorClickIcon size={24} weight="bold" />,
    title: "Desk mode default",
    body: "No cameras, no Python, no rig: mouse, keyboard, and voice drive everything. Press ? in the room for the full cheat-sheet.",
  },
];

function TheRoom() {
  return (
    <section id="room" className="border-y border-paper-2 bg-paper-main py-20">
      <div className="mx-auto max-w-6xl px-4">
        <Heading3 className="mb-4 text-center text-surface-ink">
          Built for a room full of people
        </Heading3>
        <Body className="mx-auto mb-12 max-w-2xl text-center text-surface-grey-2">
          Every surface is an input: your voice, your phone, your hands, the walls.
        </Body>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-paper-2 bg-paper-0 p-6">
              <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-lg bg-paper-1 text-primary-green">
                {f.icon}
              </div>
              <Body bold className="mb-2 text-surface-ink">
                {f.title}
              </Body>
              <Body className="text-sm text-surface-grey-2">{f.body}</Body>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function RunIt() {
  return (
    <section id="run" className="bg-paper-0 py-20">
      <div className="mx-auto max-w-3xl px-4 text-center">
        <Heading3 className="mb-4 text-surface-ink">One command to raise the room</Heading3>
        <Body className="mb-8 text-surface-grey-2">
          Clone the repo, run the script, point projectors at two walls (or one,
          or just your laptop) — and start talking.
        </Body>
        <div className="mb-8 overflow-x-auto rounded-2xl bg-surface-ink p-6 text-left">
          <pre className="font-mono text-sm leading-7 text-paper-1">
            <code>
              <span className="text-surface-grey">$ </span>git clone {GITHUB_URL}.git{"\n"}
              <span className="text-surface-grey">$ </span>cd vibecode-room{"\n"}
              <span className="text-surface-grey">$ </span>./run-room.sh
            </code>
          </pre>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Chip size="small">--single for one wall</Chip>
          <Chip size="small">--gesture for the depth camera</Chip>
          <Chip size="small">--real-hands for pinch control</Chip>
          <Chip size="small">--fake to demo with no hardware</Chip>
        </div>
        <div className="mt-10 flex justify-center">
          <Button
            as="a"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            leftIcon={<GithubLogoIcon weight="bold" />}
          >
            Get the code
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-paper-main font-parkBody text-surface-ink">
      <Header />
      <main>
        <Hero />
        <HowItWorks />
        <TheRoom />
        <RunIt />
      </main>
      <Footer />
    </div>
  );
}
