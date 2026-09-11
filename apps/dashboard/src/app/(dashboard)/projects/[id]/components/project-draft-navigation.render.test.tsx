import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
const h = vi.hoisted(() => ({
  state: {
    id: "prod",
    projectData: {
      id: "prod",
      name: "Commercial Web",
      environmentName: "Production",
      environmentSlug: "production",
      activeDeploymentId: null,
    },
    environments: [
      { id: "prod", name: "Production", slug: "production", type: "production", gitBranch: "main" },
      {
        id: "prt",
        name: "PRT",
        slug: "prt",
        type: "preview",
        gitBranch: "main",
        activeDeploymentId: "ready-prt",
      },
    ],
    activeTab: "overview",
    tabs: [],
  },
}));
vi.mock("@/context/ProjectSettingsContext", () => ({ useProjectSettings: () => h.state }));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: () => ({ isLoading: false }),
  PROJECT_INFO_NOT_FOUND: "not-found",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: vi.fn(), hideModal: vi.fn() }),
}));
vi.mock("./DraftProjectView", () => ({ DraftProjectView: () => <div>Draft configuration</div> }));
vi.mock("./DomainSettings", () => ({ DomainSettings: () => null }));
vi.mock("./GitSettings", () => ({ GitSettings: () => null }));
vi.mock("./IncomingWebhooks", () => ({ IncomingWebhooks: () => null }));
vi.mock("./BuildSettings", () => ({ BuildSettings: () => null }));
vi.mock("./LogsSettings", () => ({ LogsSettings: () => null }));
vi.mock("./BackupSettings", () => ({ BackupSettings: () => null }));
vi.mock("./Deployments", () => ({ Deployments: () => null }));
vi.mock("./HealthTab", () => ({ HealthTab: () => null }));
vi.mock("./MonitoringTab", () => ({ MonitoringTab: () => null }));
vi.mock("./AdvancedSettings", () => ({ AdvancedSettings: () => null }));
vi.mock("./OverviewTab", () => ({ OverviewTab: () => null }));
vi.mock("./AppConfiguration", () => ({ AppConfiguration: () => null }));
vi.mock("./ServicesTab", () => ({ ServicesTab: () => null }));
vi.mock("./ProjectSidebar", () => ({ ProjectSidebar: () => null, ProjectMobileTabs: () => null }));
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }));
vi.mock("@/components/app-settings/AppSettingsForm", () => ({ isSchemaAppTemplate: () => false }));
import Page from "../[[...slug]]/page";

describe("draft project navigation", () => {
  it("keeps the environment switcher when Production is a draft and PRT is running", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Page />
      </I18nProvider>,
    );
    expect(html).toContain("Draft configuration");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Production");
  });
});
