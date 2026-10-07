// No DOM needed: renderToStaticMarkup runs no effects, and the row is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import type { Project } from "@/constants/mock";
import ProjectCard from "./ProjectCard";
import ProjectGridCard from "./ProjectGridCard";

/**
 * Two lies this row used to tell, both seen in the field on one Convex app:
 *
 *   1. With no route at all it printed `<slug>.<baseDomain>` — "convex.opsh.io"
 *      in the Apps list, while that project's own Domains page said "No domain".
 *   2. With a failed latest deploy it printed the green "Live" pill, because the
 *      status derivation returned live on `activeDeploymentId` before it ever
 *      looked at the failure.
 */

const project = (over: Partial<Project> & { primaryDomain?: string | null }) =>
  ({
    id: "p1",
    name: "Convex",
    slug: "convex",
    framework: "docker",
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    ...over,
  }) as Project & { primaryDomain?: string | null };

function render(p: Project & { primaryDomain?: string | null }) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ModalProvider>
        <ProjectCard project={p} />
      </ModalProvider>
    </I18nProvider>,
  );
}

/** Strip tags so assertions read against what the user actually sees. */
function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("ProjectCard — hostname", () => {
  it("prints no hostname for a project with no persisted route", () => {
    const out = text(render(project({ activeDeploymentId: "d1" })));
    expect(out).toContain("Convex");
    expect(out).not.toContain("convex.");
    expect(out).not.toContain("opsh.io");
  });

  it("prints the persisted primary route when there is one", () => {
    const out = text(render(project({ primaryDomain: "convex.example.com" })));
    expect(out).toContain("convex.example.com");
  });
});

describe("GitOps project cards", () => {
  it.each([ProjectCard, ProjectGridCard])("names the precise environment and links its release plan", Card => {
    const html = renderToStaticMarkup(<I18nProvider><ModalProvider><Card project={project({ name: "Admin", managementMode: "gitops", releaseEnvironment: "preview", activeVersion: 6 })} /></ModalProvider></I18nProvider>);
    expect(text(html)).toContain("Admin · PRT");
    expect(text(html)).toContain("Deployment number 6"); expect(text(html)).not.toContain("v6");
    expect(text(html)).toContain("Version could not be verified");
    expect(html).toContain('href="/projects/p1/release"');
    expect(html).toContain('aria-label="View release plan · Admin · PRT"');
  });
  it("separates actual and target digests and the OSS source", () => {
    const image = { image: "ghcr.io/example/web", digest: `sha256:${"a".repeat(64)}`, gitSha: "b".repeat(40) };
    const html = render(project({ managementMode: "gitops", releaseEnvironment: "production", releaseOverview: { kind: "available", current: { images: { web: image }, deploymentId: "d", configurationHash: null, ossGitSha: "c".repeat(40), verified: true }, target: { images: { web: { ...image, gitSha: "d".repeat(40) } }, ossGitSha: "e".repeat(40) }, stale: false, checkedAt: "2026-10-07T00:00:00.000Z" } }));
    const out = text(html);
    expect(out).toContain("Production"); expect(out).toContain("bbbbbbbbbbbb"); expect(out).toContain("dddddddddddd"); expect(out).toContain("OSS · cccccccccccc");
    expect(html).toContain(image.digest);
  });
});

describe("ProjectCard — status pill", () => {
  it("labels an ordinary failed attempt without inventing an action", () => {
    const html = render(
      project({
        activeDeploymentId: "d1",
        latestDeploymentId: "d2",
        latestDeploymentStatus: "failed",
      }),
    );
    const out = text(html);
    expect(out).toContain("Deploy failed");
    expect(out).not.toContain("Action Required");
    expect(out).not.toContain("Live");
    expect(html).toContain('href="/build/d2"');
    expect(html).not.toContain('data-project-action-required="true"');
  });

  it("reads Failed when the failed deploy is all the project has", () => {
    const out = text(
      render(project({ latestDeploymentId: "d1", latestDeploymentStatus: "failed" })),
    );
    expect(out).toContain("Failed");
    expect(out).not.toContain("Live");
  });

  it("still reads Live for a healthy release", () => {
    const out = text(render(project({ activeDeploymentId: "d1" })));
    expect(out).toContain("Live");
  });

  it("links a genuine action-required badge to the owning deployment screen", () => {
    const out = render(
      project({
        activeDeploymentId: "d1",
        latestDeploymentId: "d2",
        latestDeploymentStatus: "action_required",
        latestDeploymentBlocked: true,
      }),
    );
    expect(out).toContain("Action Required");
    expect(out).toContain('data-project-action-required="true"');
    expect(out).toContain('href="/projects/p1/deployments"');
  });

  it("links a routing action directly to Domains", () => {
    const out = render(
      project({
        activeDeploymentId: "d1",
        latestDeploymentId: "d1",
        latestDeploymentStatus: "ready",
        routingUnsynced: true,
      }),
    );
    expect(out).toContain('href="/projects/p1/domains"');
  });
});
