// Presentation only. The host owns authenticated requests and validates all grants.
export function githubConnectorPanel({ connection, repositoryList, draft = {}, busy = false, uncertainAdmission = false,
  onConnect, onRefresh, onDisconnect, onRead, onDraft } = {}) {
  const el = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const panel = el('section', undefined, 'setting-group research-tool github-connector');
  panel.setAttribute('aria-label', 'GitHub connection');
  panel.append(el('h2', 'GitHub release updates'), el('p', 'Read the latest published release from a repository your connected account can access.', 'preview-info'));
  const action = (text, callback) => {
    const button = el('button', text, 'button button-outline'); button.type = 'button';
    button.disabled = busy || typeof callback !== 'function';
    button.addEventListener('click', () => { if (!button.disabled) callback(); });
    return button;
  };
  const status = connection?.status;
  if (status === 'not_configured' || !connection) {
    panel.append(el('p', 'GitHub is not configured on this runtime.', 'state-notice')); return panel;
  }
  panel.append(el('p', 'GitHub access stays with your account. Transferring this NFT does not transfer your GitHub connection.', 'preview-info'));
  if (status === 'not_connected' || status === 'reconnect_required') {
    panel.append(el('p', status === 'reconnect_required' ? 'Reconnect to authorize new reads. Previous work will not retry automatically.' : 'Connect a GitHub App with Metadata and Contents read permissions only.', 'state-notice'), action(status === 'reconnect_required' ? 'Reconnect GitHub' : 'Connect GitHub', onConnect));
    if (status === 'reconnect_required') panel.append(el('p', 'You can remove the retained connection without reconnecting. Saved private results remain; provider revocation is reported separately.', 'preview-info'), action('Disconnect GitHub here', onDisconnect));
    return panel;
  }
  const validGrant = status === 'connected' && typeof connection.generation === 'string' && connection.generation.length > 0
    && typeof connection.account?.login === 'string' && connection.permissions?.metadata === 'read' && connection.permissions?.contents === 'read';
  if (!validGrant) {
    panel.append(el('p', 'GitHub connection could not be verified. Saved results remain available.', 'state-notice'), action('Refresh connection', onRefresh)); return panel;
  }
  // Capture the displayed generation. Never replace it with a newer grant at submit.
  const generation = connection.generation;
  panel.append(el('p', `Connected as ${connection.account.login}. Metadata and Contents: read only.`, 'preview-info'));
  const listed = repositoryList?.generation === generation && Array.isArray(repositoryList.repositories);
  const repositories = listed ? repositoryList.repositories.filter(repo => typeof repo.id === 'string' && typeof repo.name === 'string') : [];
  if (!listed || !repositories.length) {
    panel.append(el('p', listed ? 'No permitted repositories are available.' : 'Refresh to load repositories for this connection.', 'state-notice'), action('Refresh repositories', onRefresh));
  } else {
    const form = el('form'); form.className = 'research-form';
    const repoLabel = el('label', 'Repository'), select = el('select', undefined, 'field');
    select.setAttribute('aria-label', 'GitHub repository'); select.required = true;
    const placeholder = el('option', 'Choose a permitted repository'); placeholder.value = ''; select.append(placeholder);
    for (const repo of repositories) { const option = el('option', repo.name); option.value = repo.id; select.append(option); }
    select.value = repositories.some(repo => repo.id === draft.repositoryId) ? draft.repositoryId : '';
    repoLabel.append(select);
    const questionLabel = el('label', 'Question about the release'), question = el('textarea', undefined, 'field');
    question.setAttribute('aria-label', 'Question about the GitHub release'); question.required = true; question.maxLength = 4000; question.rows = 3; question.value = draft.question || '';
    questionLabel.append(question);
    const consentLabel = el('label', undefined, 'checkbox-row'), consent = el('input'); consent.type = 'checkbox'; consent.required = true;
    const consentText = el('span');
    const updateConsent = () => { const repo = repositories.find(item => item.id === select.value); consentText.textContent = `Allow this run to read the latest published release from ${repo?.name || 'the selected repository'} using my connected GitHub account. This run uses my hosting allowance and any active prepaid credits.`; };
    updateConsent(); consentLabel.append(consent, consentText);
    const changed = () => { consent.checked = false; updateConsent(); onDraft?.({ repositoryId: select.value, question: question.value, generation }); };
    select.addEventListener('change', changed); question.addEventListener('input', changed);
    const submit = el('button', 'Read latest release', 'button button-primary'); submit.type = 'submit'; submit.disabled = busy || uncertainAdmission || typeof onRead !== 'function';
    form.append(repoLabel, questionLabel, el('p', 'One read only. This permission does not schedule recurring work.', 'preview-info'), consentLabel, submit);
    if (uncertainAdmission) form.append(el('p', 'The previous request could not be confirmed. Check Activity before preparing another run.', 'state-notice'));
    if (repositoryList.coverage?.hasMore) form.append(el('p', `Showing ${repositories.length} permitted repositories. More repositories exist beyond this list.`, 'preview-info'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (busy || uncertainAdmission || typeof onRead !== 'function' || !consent.checked || !question.value.trim() || !repositories.some(repo => repo.id === select.value)) return;
      consent.checked = false;
      onRead({ objective: question.value.trim(), github: { repositoryId: select.value, generation, consent: true } });
    });
    for (const input of form.querySelectorAll('input,select,textarea')) input.disabled = busy;
    panel.append(form);
  }
  const disconnect = el('details'); disconnect.append(el('summary', 'Disconnect GitHub'), el('p', 'Stops future GitHub reads here. Saved private results remain. Provider revocation is reported separately after confirmation.', 'preview-info'), action('Disconnect GitHub here', onDisconnect)); panel.append(disconnect);
  return panel;
}
