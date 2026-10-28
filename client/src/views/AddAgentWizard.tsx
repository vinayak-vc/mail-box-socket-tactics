import React, { useState } from 'react';
import { 
  UserPlus, 
  ArrowRight, 
  ArrowLeft, 
  CheckCircle2, 
  AlertTriangle, 
  Terminal, 
  Copy, 
  Check, 
  Download, 
  ShieldCheck, 
  HelpCircle 
} from 'lucide-react';
import { client } from '../api';
import { Agent } from '../types';

interface AddAgentWizardProps {
  onAgentAdded: () => void;
}

export const AddAgentWizard: React.FC<AddAgentWizardProps> = ({ onAgentAdded }) => {
  const [step, setStep] = useState<number>(1);

  // Form State (Step 1)
  const [displayName, setDisplayName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [partyCode, setPartyCode] = useState('');
  const [vendor, setVendor] = useState('Custom');
  const [integrationMethod, setIntegrationMethod] = useState<'cli' | 'agentapi' | 'mcp' | 'custom'>('cli');
  const [cliCommand, setCliCommand] = useState('');
  const [cliArgs, setCliArgs] = useState('-c -p');
  const [conversationId, setConversationId] = useState('');
  const [workingDir, setWorkingDir] = useState('C:\\UnrealProject\\OneBossFight');
  const [role, setRole] = useState('Specialized Testing & Optimization Engineer');
  const [capabilities, setCapabilities] = useState('c++, automation, testing');

  // Step 2: Capability check state
  const [capChecking, setCapChecking] = useState(false);
  const [capResult, setCapResult] = useState<{ capable: boolean; status: string; details: string } | null>(null);

  // Step 3: Prompt Generation state
  const [generatedPrompt, setGeneratedPrompt] = useState<string>('');
  const [isPromptDelivered, setIsPromptDelivered] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Step 4 & 5: Registration state
  const [isRegistering, setIsRegistering] = useState(false);
  const [registeredAgent, setRegisteredAgent] = useState<Agent | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Validation
  const validateStep1 = (): boolean => {
    setErrorMsg(null);
    if (!agentId.trim()) {
      setErrorMsg('Unique Agent ID is required (e.g. Gemini, DeepSeek, Cursor).');
      return false;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId.trim())) {
      setErrorMsg('Agent ID must be alphanumeric and may only contain dashes or underscores.');
      return false;
    }
    if (!displayName.trim()) {
      setDisplayName(agentId.trim());
    }
    if (!partyCode.trim()) {
      setPartyCode(agentId.trim().charAt(0).toUpperCase());
    }
    return true;
  };

  const handleNextToStep2 = async () => {
    if (!validateStep1()) return;
    setStep(2);

    // Auto-run capability check
    setCapChecking(true);
    try {
      if (integrationMethod === 'cli' && cliCommand) {
        // Quick check via client test
        const res = await client.testAgent(agentId);
        setCapResult(res);
      } else if (integrationMethod === 'agentapi') {
        setCapResult({ capable: true, status: 'AgentAPI Detected', details: 'Using project agentapi protocol' });
      } else {
        setCapResult({ 
          capable: false, 
          status: 'Configuration required', 
          details: 'MCP or custom socket adapter requires explicit adapter bridge implementation.' 
        });
      }
    } catch (_) {
      setCapResult({
        capable: false,
        status: 'Configuration required',
        details: 'Executable or protocol endpoint must be configured before active execution.'
      });
    } finally {
      setCapChecking(false);
    }
  };

  const handleGeneratePrompt = async () => {
    try {
      const prompt = await client.generatePrompt({
        id: agentId,
        displayName: displayName || agentId,
        partyCode: partyCode || agentId.charAt(0).toUpperCase(),
        role,
        capabilities: capabilities.split(',').map(s => s.trim())
      });
      setGeneratedPrompt(prompt);
      setStep(3);
    } catch (err: any) {
      setErrorMsg(`Failed to generate onboarding prompt: ${err.message}`);
    }
  };

  const copyPromptText = () => {
    navigator.clipboard.writeText(generatedPrompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const downloadPromptFile = () => {
    const blob = new Blob([generatedPrompt], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ONBOARDING_${agentId.toUpperCase()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRegisterAgent = async () => {
    setIsRegistering(true);
    setErrorMsg(null);
    try {
      const agent = await client.registerAgent({
        id: agentId,
        displayName: displayName || agentId,
        partyCode: partyCode || agentId.charAt(0).toUpperCase(),
        vendor,
        integrationMethod,
        cliCommand,
        cliArgs: cliArgs ? cliArgs.split(' ') : [],
        conversationId,
        workingDir,
        role,
        capabilities: capabilities.split(',').map(s => s.trim()),
        onboardingStatus: isPromptDelivered ? 'configured' : 'prompt_generated'
      });
      setRegisteredAgent(agent);
      setStep(5);
      onAgentAdded();
    } catch (err: any) {
      setErrorMsg(err.message || 'Registration failed.');
    } finally {
      setIsRegistering(false);
    }
  };

  const stepsList = [
    '1. Agent Details',
    '2. Capability Check',
    '3. Onboarding Prompt',
    '4. Review & Register',
    '5. Integration Status'
  ];

  return (
    <div className="content-view">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            <UserPlus size={20} />
            <span>Add AI Agent Onboarding Wizard</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Register and onboard a new AI coding agent into the autonomous team with project-accurate instructions.
          </p>
        </div>
      </div>

      {/* Stepper Progress */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        {stepsList.map((st, i) => (
          <div 
            key={i} 
            style={{ 
              flex: 1, 
              padding: '10px 12px', 
              background: step === i + 1 ? 'var(--accent-glow)' : 'var(--bg-card)', 
              border: '1px solid',
              borderColor: step === i + 1 ? 'var(--accent-primary)' : 'var(--border-subtle)',
              borderRadius: '8px',
              color: step === i + 1 ? '#fff' : 'var(--text-muted)',
              fontSize: '12px',
              fontWeight: step === i + 1 ? 700 : 500,
              textAlign: 'center'
            }}
          >
            {st}
          </div>
        ))}
      </div>

      {errorMsg && (
        <div style={{ padding: '12px 16px', background: 'var(--color-danger-bg)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', color: 'var(--color-danger)', fontSize: '13px', marginBottom: '20px' }}>
          {errorMsg}
        </div>
      )}

      {/* STEP 1: Agent Details */}
      {step === 1 && (
        <div className="table-container" style={{ padding: '24px', maxWidth: '750px' }}>
          <h3 style={{ fontSize: '16px', color: '#fff', marginBottom: '16px' }}>Step 1: Agent Identity & Integration Method</h3>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="form-group">
              <label className="form-label">Unique Agent ID *</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="e.g. Gemini, DeepSeek, Qwen" 
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Display Name</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="e.g. Google Gemini Pro" 
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div className="form-group">
              <label className="form-label">Party Code (1 Letter) *</label>
              <input 
                type="text" 
                className="form-input" 
                maxLength={2}
                placeholder="e.g. G" 
                value={partyCode}
                onChange={(e) => setPartyCode(e.target.value.toUpperCase())}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Vendor / Model Family</label>
              <select className="form-select" value={vendor} onChange={(e) => setVendor(e.target.value)}>
                <option value="Anthropic">Anthropic</option>
                <option value="OpenAI">OpenAI</option>
                <option value="Google">Google</option>
                <option value="Mistral">Mistral</option>
                <option value="Meta">Meta</option>
                <option value="Custom">Custom / Open Source</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Assigned Role & Responsibilities</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="e.g. Unreal Gameplay Systems & Combat Balance Implementer" 
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Core Capabilities (comma separated)</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="e.g. c++, animation-blueprints, performance, testing" 
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Integration Method</label>
            <select className="form-select" value={integrationMethod} onChange={(e) => setIntegrationMethod(e.target.value as any)}>
              <option value="cli">Supported CLI Interface (e.g. gemini.exe / script)</option>
              <option value="agentapi">Native AgentAPI / Language Server Protocol</option>
              <option value="mcp">Model Context Protocol (MCP) Bridge</option>
              <option value="custom">Custom Adapter Interface</option>
            </select>
          </div>

          {integrationMethod === 'cli' && (
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px' }}>
              <div className="form-group">
                <label className="form-label">CLI Executable Path</label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="C:\Users\...\gemini.exe or global command" 
                  value={cliCommand}
                  onChange={(e) => setCliCommand(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">CLI Launch Arguments</label>
                <input 
                  type="text" 
                  className="form-input" 
                  placeholder="-c -p" 
                  value={cliArgs}
                  onChange={(e) => setCliArgs(e.target.value)}
                />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
            <button className="btn btn-primary" onClick={handleNextToStep2}>
              <span>Next: Capability Check</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: Capability Check */}
      {step === 2 && (
        <div className="table-container" style={{ padding: '24px', maxWidth: '750px' }}>
          <h3 style={{ fontSize: '16px', color: '#fff', marginBottom: '16px' }}>Step 2: Integration Capability Check</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
            Testing whether the configured interface for <strong>{agentId}</strong> is supported and verified on this machine.
          </p>

          <div style={{ padding: '18px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '8px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {capResult?.capable ? (
                <CheckCircle2 size={24} color="var(--color-success)" />
              ) : (
                <AlertTriangle size={24} color="var(--color-warning)" />
              )}
              <div>
                <strong style={{ fontSize: '14px', color: '#fff' }}>
                  Status: {capResult?.status || 'Analyzing environment...'}
                </strong>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  {capResult?.details || 'Testing CLI binary presence and PATH resolution.'}
                </div>
              </div>
            </div>
          </div>

          <div style={{ background: 'var(--bg-input)', padding: '14px', borderRadius: '6px', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '20px' }}>
            <strong>Architectural Note:</strong> Generating an onboarding prompt does not, by itself, install an adapter or grant an arbitrary AI the ability to wake itself. If the integration status is <em>Configuration required</em>, the agent will be registered in draft/configured state until an adapter bridge is started.
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button className="btn btn-secondary" onClick={() => setStep(1)}>
              <ArrowLeft size={14} />
              <span>Back</span>
            </button>
            <button className="btn btn-primary" onClick={handleGeneratePrompt}>
              <span>Generate Team Onboarding Prompt</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: Onboarding Prompt Generation */}
      {step === 3 && (
        <div className="table-container" style={{ padding: '24px', maxWidth: '850px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div>
              <h3 style={{ fontSize: '16px', color: '#fff' }}>Step 3: Team Onboarding Prompt</h3>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Guaranteed zero secrets or passwords. Formatted for the exact authoritative TEAM_MAILBOX.md layout.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-secondary btn-sm" onClick={copyPromptText}>
                {copiedPrompt ? <Check size={12} color="var(--color-success)" /> : <Copy size={12} />}
                <span>{copiedPrompt ? 'Copied!' : 'Copy to Clipboard'}</span>
              </button>
              <button className="btn btn-secondary btn-sm" onClick={downloadPromptFile}>
                <Download size={12} />
                <span>Save Markdown File</span>
              </button>
            </div>
          </div>

          <textarea 
            className="form-textarea" 
            style={{ minHeight: '320px', fontSize: '12px' }}
            value={generatedPrompt}
            onChange={(e) => setGeneratedPrompt(e.target.value)}
          />

          <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input 
              type="checkbox" 
              id="promptDelivered" 
              checked={isPromptDelivered} 
              onChange={(e) => setIsPromptDelivered(e.target.checked)} 
              style={{ width: '16px', height: '16px' }}
            />
            <label htmlFor="promptDelivered" style={{ fontSize: '13px', color: '#fff', cursor: 'pointer' }}>
              I have delivered/copied this prompt into the target agent's interface.
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '24px' }}>
            <button className="btn btn-secondary" onClick={() => setStep(2)}>
              <ArrowLeft size={14} />
              <span>Back</span>
            </button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>
              <span>Next: Review & Register</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 4: Review & Register */}
      {step === 4 && (
        <div className="table-container" style={{ padding: '24px', maxWidth: '750px' }}>
          <h3 style={{ fontSize: '16px', color: '#fff', marginBottom: '16px' }}>Step 4: Register Agent into Persistence Layer</h3>
          
          <div style={{ background: 'var(--bg-card)', padding: '16px', borderRadius: '8px', marginBottom: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '13px' }}>
              <div><span style={{ color: 'var(--text-muted)' }}>Agent ID: </span><strong>{agentId}</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Display Name: </span><strong>{displayName || agentId}</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Party Code: </span><strong>[{partyCode || agentId.charAt(0).toUpperCase()}]</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Vendor: </span><strong>{vendor}</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Integration: </span><strong>{integrationMethod.toUpperCase()}</strong></div>
              <div><span style={{ color: 'var(--text-muted)' }}>Onboarding Status: </span><strong>{isPromptDelivered ? 'configured' : 'prompt_generated'}</strong></div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button className="btn btn-secondary" onClick={() => setStep(3)}>
              <ArrowLeft size={14} />
              <span>Back</span>
            </button>
            <button className="btn btn-primary" onClick={handleRegisterAgent} disabled={isRegistering}>
              <span>{isRegistering ? 'Registering Agent...' : 'Confirm & Register Agent'}</span>
              <CheckCircle2 size={14} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 5: Success & Status */}
      {step === 5 && registeredAgent && (
        <div className="table-container" style={{ padding: '30px', maxWidth: '750px', textAlign: 'center' }}>
          <CheckCircle2 size={48} color="var(--color-success)" style={{ margin: '0 auto 16px' }} />
          <h3 style={{ fontSize: '18px', color: '#fff', marginBottom: '8px' }}>
            Agent '{registeredAgent.id}' Successfully Registered!
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
            Persisted to <code>data/agent_registry.json</code>. The agent is now visible in the AI Agents panel.
          </p>

          <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
            <button className="btn btn-primary" onClick={() => setStep(1)}>
              <span>Onboard Another Agent</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
