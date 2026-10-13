import type { FormEvent, RefObject } from "react";
import {
  ExternalLink,
  FileCode2,
  GitPullRequest,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { PullRequestDetails, PullRequestState } from "../git-types";

export interface PullRequestsPanelProps {
  pullRequests: PullRequestState | null;
  loadingTab: boolean;
  working: boolean;
  selectedPr: number | null;
  prDetails: PullRequestDetails | null;
  prDetailsLoading: boolean;
  prTitle: string;
  prBody: string;
  prBase: string;
  prDraft: boolean;
  showPrDialog: boolean;
  prDialogRef: RefObject<HTMLDialogElement | null>;
  onRefresh: () => void;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onBaseChange: (value: string) => void;
  onDraftChange: (value: boolean) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onOpenDetails: (number: number | null) => void;
  onClearDetails: () => void;
  onOpenExternal: (url: string) => void;
}

export function PullRequestsPanel({
  pullRequests,
  loadingTab,
  working,
  selectedPr,
  prDetails,
  prDetailsLoading,
  prTitle,
  prBody,
  prBase,
  prDraft,
  showPrDialog,
  prDialogRef,
  onRefresh,
  onOpenCreate,
  onCloseCreate,
  onTitleChange,
  onBodyChange,
  onBaseChange,
  onDraftChange,
  onCreate,
  onOpenDetails,
  onClearDetails,
  onOpenExternal,
}: PullRequestsPanelProps) {
  return (
    <section className="git-workspace__list-view" aria-label="GitHub pull requests">
      <div className="git-workspace__pane-heading">
        <div>
          <span className="git-workspace__eyebrow">GITHUB</span>
          <h2>Pull requests</h2>
          {pullRequests?.repository && (
            <span className="git-workspace__repo-name">{pullRequests.repository}</span>
          )}
        </div>
        <div className="git-workspace__heading-actions">
          <button
            type="button"
            className="git-workspace__icon-button"
            onClick={onRefresh}
            disabled={loadingTab}
            aria-label="Refresh pull requests"
          >
            <RefreshCw size={15} />
          </button>
          {pullRequests?.available && pullRequests.authenticated && (
            <button
              type="button"
              className="git-workspace__button git-workspace__button--primary"
              onClick={onOpenCreate}
            >
              <Plus size={14} /> Create pull request
            </button>
          )}
        </div>
      </div>
      {loadingTab && (
        <div className="git-workspace__loading">
          <LoaderCircle size={17} className="git-workspace__spin" /> Checking GitHub CLI…
        </div>
      )}
      {!loadingTab && pullRequests && !pullRequests.repository && (
        <div className="git-workspace__capability-note">
          <ShieldAlert size={20} />
          <div>
            <strong>No GitHub origin remote found</strong>
            <p>
              PR details are available for repositories whose origin points to
              github.com.
            </p>
          </div>
        </div>
      )}
      {!loadingTab && pullRequests?.repository && !pullRequests.available && (
        <div className="git-workspace__capability-note">
          <ShieldAlert size={20} />
          <div>
            <strong>GitHub CLI is unavailable</strong>
            <p>
              Install <code>gh</code> to read pull-request details through your
              existing GitHub sign-in.
            </p>
          </div>
        </div>
      )}
      {!loadingTab && pullRequests?.available && !pullRequests.authenticated && (
        <div className="git-workspace__capability-note">
          <ShieldAlert size={20} />
          <div>
            <strong>GitHub CLI needs sign-in</strong>
            <p>
              Authenticate <code>gh</code> before loading or creating pull
              requests. Vibe Desktop does not store a separate GitHub
              credential.
            </p>
          </div>
        </div>
      )}
      {!loadingTab && pullRequests?.authenticated && !pullRequests.items.length && (
        <div className="git-workspace__list-empty">
          <GitPullRequest size={18} /> No open pull requests for this repository.
        </div>
      )}
      <div className="git-workspace__pr-list">
        {pullRequests?.items.map((item) => (
          <article
            className={
              selectedPr === item.number
                ? "git-workspace__pr-item is-selected"
                : "git-workspace__pr-item"
            }
            key={item.number ?? item.url}
          >
            <button
              type="button"
              className="git-workspace__pr-select"
              onClick={() => onOpenDetails(item.number)}
              disabled={!item.number || prDetailsLoading}
              title="Show files changed and check status"
              aria-label={`Review pull request ${item.number}: ${item.title}`}
            >
              <span className="git-workspace__pr-icon">
                <GitPullRequest size={16} />
              </span>
              <span className="git-workspace__pr-main">
                <strong>{item.title}</strong>
                <span>
                  #{item.number ?? "?"} · {item.headRefName} → {item.baseRefName}
                  {item.isDraft ? " · Draft" : ""}
                </span>
              </span>
              <span className="git-workspace__pr-state">
                {item.reviewDecision || item.state}
              </span>
            </button>
            {item.url && (
              <button
                type="button"
                className="git-workspace__icon-button"
                onClick={() => onOpenExternal(item.url!)}
                aria-label={`Open pull request ${item.number} in browser`}
              >
                <ExternalLink size={15} />
              </button>
            )}
          </article>
        ))}
      </div>
      {(prDetailsLoading || prDetails) && (
        <div className="git-workspace__pr-details" aria-live="polite">
          {prDetailsLoading ? (
            <div className="git-workspace__loading">
              <LoaderCircle size={15} className="git-workspace__spin" /> Reading PR details…
            </div>
          ) : prDetails ? (
            <>
              <div className="git-workspace__pane-heading">
                <div>
                  <span className="git-workspace__eyebrow">
                    REVIEW · #{prDetails.number} · {prDetails.commits} COMMITS
                  </span>
                  <h2>{prDetails.title}</h2>
                </div>
                <button
                  type="button"
                  className="git-workspace__icon-button"
                  onClick={onClearDetails}
                  aria-label="Close pull request details"
                >
                  <X size={15} />
                </button>
              </div>
              {prDetails.body && (
                <div className="git-workspace__pr-body">
                  <ReactMarkdown>{prDetails.body}</ReactMarkdown>
                </div>
              )}
              <p className="git-workspace__group-heading">Checks · {prDetails.checks.length}</p>
              {prDetails.checks.length === 0 ? (
                <p className="git-workspace__view-note">No check runs reported.</p>
              ) : (
                prDetails.checks.map((check) => (
                  <p key={check.name} className="git-workspace__check-row">
                    <span
                      className={
                        check.conclusion === "SUCCESS"
                          ? "git-workspace__tag git-workspace__tag--ok"
                          : check.conclusion != null && check.conclusion !== "SUCCESS"
                            ? "git-workspace__tag git-workspace__tag--warn"
                            : "git-workspace__tag"
                      }
                    >
                      {check.conclusion ?? check.status}
                    </span>{" "}
                    {check.name}
                  </p>
                ))
              )}
              <p className="git-workspace__group-heading">
                Files changed · {prDetails.files.length}
                {prDetails.filesTruncated ? " (truncated)" : ""}
              </p>
              {prDetails.files.map((file) => (
                <p key={file.path} className="git-workspace__check-row" title={file.path}>
                  <FileCode2 size={13} /> {file.path}{" "}
                  <small>
                    +{file.additions} −{file.deletions}
                  </small>
                </p>
              ))}
              {prDetails.url && (
                <button
                  type="button"
                  className="git-workspace__button git-workspace__button--quiet"
                  onClick={() => onOpenExternal(prDetails.url!)}
                >
                  Open pull request #{prDetails.number} in browser <ExternalLink size={13} />
                </button>
              )}
              <p className="git-workspace__view-note">
                Review approvals happen on GitHub. Approving or merging from
                here is intentionally unsupported.
              </p>
            </>
          ) : null}
        </div>
      )}
      <p className="git-workspace__view-note">
        Opening a PR is a separate action. Creating one requires an
        authenticated <code>gh</code> CLI and a branch already published to
        origin.
      </p>
      <dialog
        className="git-workspace__pr-dialog"
        ref={prDialogRef}
        aria-labelledby="git-pr-dialog-title"
        onClose={onCloseCreate}
        onCancel={onCloseCreate}
      >
        {showPrDialog && (
          <form onSubmit={onCreate}>
            <div className="git-workspace__dialog-head">
              <div className="git-workspace__dialog-mark">
                <GitPullRequest size={19} />
              </div>
              <div>
                <span className="git-workspace__eyebrow">EXPLICIT REMOTE ACTION</span>
                <h2 id="git-pr-dialog-title">Create pull request</h2>
              </div>
              <button
                type="button"
                className="git-workspace__icon-button"
                onClick={onCloseCreate}
                aria-label="Close pull request form"
              >
                <X size={17} />
              </button>
            </div>
            <p className="git-workspace__dialog-note">
              This submits a new PR using your authenticated GitHub CLI. The
              branch must already be synchronized with origin; Vibe Desktop does
              not push it for you.
            </p>
            <label htmlFor="git-pr-title">Title</label>
            <input
              id="git-pr-title"
              value={prTitle}
              onChange={(event) => onTitleChange(event.target.value)}
              maxLength={256}
              autoFocus
              required
            />
            <label htmlFor="git-pr-body">Description</label>
            <textarea
              id="git-pr-body"
              value={prBody}
              onChange={(event) => onBodyChange(event.target.value)}
              maxLength={50000}
              rows={7}
              placeholder="Describe the changes for reviewers"
            />
            <label htmlFor="git-pr-base">
              Base branch <span>Optional</span>
            </label>
            <input
              id="git-pr-base"
              value={prBase}
              onChange={(event) => onBaseChange(event.target.value)}
              maxLength={256}
              placeholder="main"
            />
            <label className="git-workspace__checkbox">
              <input
                type="checkbox"
                checked={prDraft}
                onChange={(event) => onDraftChange(event.target.checked)}
              />{" "}
              Create as draft
            </label>
            <div className="git-workspace__dialog-actions">
              <button
                type="button"
                className="git-workspace__button git-workspace__button--quiet"
                onClick={onCloseCreate}
                disabled={working}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="git-workspace__button git-workspace__button--primary"
                disabled={working || !prTitle.trim()}
              >
                {working ? (
                  <LoaderCircle size={14} className="git-workspace__spin" />
                ) : (
                  <GitPullRequest size={14} />
                )}
                Create pull request
              </button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  );
}
