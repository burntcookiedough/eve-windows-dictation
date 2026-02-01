import { useState } from 'react';

// =============================================================================
// TRANSCRIBER UI - Main Application Component
// =============================================================================
// 
// This is the main UI shell for the transcription application. It provides:
// - Three views: History (default), Settings, and Test
// - Persistent status indicators for recording state and server connection
// - Dark theme using Tailwind's zinc color palette
//
// ARCHITECTURE NOTES:
// - This is a single-file React component designed for Electron
// - All state is local React state - wire up to your actual state management
// - Integration points are marked with "TODO:" comments
// - Uses Tailwind CSS for styling (ensure Tailwind is configured in your project)
//
// TO INTEGRATE:
// 1. Replace mockHistory with real data from your transcription store
// 2. Wire up handlers (handleCopy, handleDelete, etc.) to actual functionality
// 3. Connect isConnected/isRecording to your app's actual state
// 4. Populate audio device dropdown with system devices
// 5. Persist settings to your config store
//
// =============================================================================

// =============================================================================
// MOCK DATA
// =============================================================================
// 
// Replace this array with real data from your transcription history store.
// Each item should have these properties:
// - id: unique identifier
// - text: the transcribed text
// - timestamp: Unix timestamp (milliseconds) when transcription occurred
// - language: detected/configured language code (e.g., "en", "de")
// - device: inference device used ("cuda", "cpu", etc.)
// - charCount: character count of final text
// - wordCount: word count of final text
// - duration: audio duration in seconds
//
const mockHistory = [
  { 
    id: 1, 
    text: "Hey, just a quick note to remind myself to check the deployment logs later today and make sure the new authentication flow is working properly.", 
    timestamp: Date.now() - 1000 * 60 * 5, 
    language: "en", 
    device: "cuda", 
    charCount: 156, 
    wordCount: 28, 
    duration: 8.4 
  },
  { 
    id: 2, 
    text: "Meeting notes from the Q4 planning session: We discussed the roadmap priorities and agreed that the transcription accuracy improvements should be the main focus for the next sprint. Sarah mentioned that the current word error rate is around 4.2% which is good but we want to get it below 3%. The team also brought up concerns about memory usage on longer recordings, so we'll need to look into streaming the audio in chunks rather than loading the entire file. Action items include: setting up the new test dataset, benchmarking against Whisper large-v3, and creating a comparison document for the stakeholders. Follow-up meeting scheduled for next Thursday at 2pm.", 
    timestamp: Date.now() - 1000 * 60 * 60 * 2, 
    language: "en", 
    device: "cuda", 
    charCount: 712, 
    wordCount: 124, 
    duration: 48.2 
  },
  { 
    id: 3, 
    text: "So I've been thinking about the architecture for the voice command system and I think we should separate it into three distinct layers. The first layer handles the raw audio capture and preprocessing, basically just getting clean audio from the microphone and detecting when speech starts and stops. The second layer is the transcription itself where we send the audio to the Whisper server and get back the text. And then the third layer is the command interpretation where we use an LLM to understand what action the user wants to take based on the transcribed text. This separation of concerns will make it much easier to swap out components later, like if we want to try a different speech recognition model or a different LLM for the command parsing.", 
    timestamp: Date.now() - 1000 * 60 * 60 * 24, 
    language: "en", 
    device: "cuda", 
    charCount: 823, 
    wordCount: 145, 
    duration: 52.1 
  },
  { 
    id: 4, 
    text: "Die Besprechung wurde auf morgen verschoben weil mehrere Teammitglieder krank sind. Wir werden stattdessen eine kurze Videokonferenz am Nachmittag machen um die wichtigsten Punkte zu besprechen.", 
    timestamp: Date.now() - 1000 * 60 * 60 * 48, 
    language: "de", 
    device: "cuda", 
    charCount: 203, 
    wordCount: 29, 
    duration: 12.8 
  },
  { 
    id: 5, 
    text: "Bug report: The application crashes when trying to transcribe audio files longer than 30 minutes. The error message says 'out of memory' but the system has 32 gigs of RAM available. I think the issue is that we're loading the entire waveform into a single tensor instead of processing it in chunks. Need to investigate the audio loading code in the preprocessing module. This is blocking the enterprise demo scheduled for Friday so it's high priority.", 
    timestamp: Date.now() - 1000 * 60 * 60 * 72, 
    language: "en", 
    device: "cpu", 
    charCount: 489, 
    wordCount: 85, 
    duration: 28.4 
  },
  { 
    id: 6, 
    text: "Note to self: call mom back about the weekend plans.", 
    timestamp: Date.now() - 1000 * 60 * 60 * 96, 
    language: "en", 
    device: "cuda", 
    charCount: 52, 
    wordCount: 10, 
    duration: 2.9 
  },
];


// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Formats a timestamp into a human-readable relative time string.
 * Examples: "5m ago", "2h ago", "3d ago"
 * 
 * @param {number} ts - Unix timestamp in milliseconds
 * @returns {string} - Relative time string
 */
const formatTime = (ts) => {
  const diff = Date.now() - ts;
  if (diff < 1000 * 60 * 60) return `${Math.floor(diff / 1000 / 60)}m ago`;
  if (diff < 1000 * 60 * 60 * 24) return `${Math.floor(diff / 1000 / 60 / 60)}h ago`;
  return `${Math.floor(diff / 1000 / 60 / 60 / 24)}d ago`;
};

/**
 * Formats a timestamp into a full human-readable date/time string.
 * Uses the browser's locale settings.
 * 
 * @param {number} ts - Unix timestamp in milliseconds
 * @returns {string} - Full date/time string
 */
const formatFullDate = (ts) => {
  return new Date(ts).toLocaleString();
};


// =============================================================================
// REUSABLE COMPONENTS
// =============================================================================

/**
 * Toggle Switch Component
 * 
 * A styled toggle switch that can be on or off.
 * The knob is properly centered vertically and animates smoothly between states.
 * 
 * @param {boolean} enabled - Current state of the toggle
 * @param {function} onChange - Callback when toggle is clicked
 */
const Toggle = ({ enabled, onChange }) => (
  <button 
    onClick={onChange}
    className={`
      w-11 h-6 rounded-full relative transition-colors duration-200 shrink-0
      focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-zinc-900 focus:ring-zinc-600
      ${enabled ? 'bg-emerald-600' : 'bg-zinc-700 hover:bg-zinc-600'}
    `}
    role="switch"
    aria-checked={enabled}
  >
    {/* 
      Toggle knob
      - Size: 18px (w-[18px] h-[18px]) to fit within 24px height with 3px padding each side
      - Position: 3px from edge when off, slides right when on
      - Uses transform for smooth animation
    */}
    <span 
      className={`
        block w-[18px] h-[18px] bg-white rounded-full shadow-sm
        absolute top-[3px] transition-all duration-200 ease-in-out
        ${enabled ? 'left-[23px]' : 'left-[3px]'}
      `} 
    />
  </button>
);

/**
 * Settings Row Component
 * 
 * A full-width settings row with label, optional description, and a control slot.
 * Used throughout the Settings view for consistent styling.
 * Spans the full available width with proper internal padding.
 * 
 * @param {string} label - Primary label text
 * @param {string} description - Optional secondary description text
 * @param {React.ReactNode} children - Control element (toggle, select, button, etc.)
 */
const SettingsRow = ({ label, description, children }) => (
  <div className="flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl hover:bg-zinc-900 transition-colors w-full">
    <div className="flex-1 min-w-0 mr-4">
      <p className="text-sm text-zinc-200">{label}</p>
      {description && (
        <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
      )}
    </div>
    <div className="shrink-0">
      {children}
    </div>
  </div>
);

/**
 * Settings Section Component
 * 
 * Groups related settings with a section header.
 * Children (SettingsRow components) are stacked with consistent spacing.
 * 
 * @param {string} title - Section header text (displayed uppercase)
 * @param {React.ReactNode} children - Settings rows
 */
const SettingsSection = ({ title, children }) => (
  <section className="w-full">
    <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
      {title}
    </h2>
    <div className="space-y-2 w-full">
      {children}
    </div>
  </section>
);


// =============================================================================
// MAIN APP COMPONENT
// =============================================================================

export default function App() {
  // ---------------------------------------------------------------------------
  // VIEW STATE
  // ---------------------------------------------------------------------------
  // Controls which view is currently displayed
  const [activeView, setActiveView] = useState('history');
  
  // Search query for filtering history
  const [searchQuery, setSearchQuery] = useState('');
  
  // Which history item is expanded (null = none)
  const [expandedItem, setExpandedItem] = useState(null);
  
  // ---------------------------------------------------------------------------
  // APPLICATION STATE
  // ---------------------------------------------------------------------------
  // TODO: Wire these up to your actual application state
  // These should reflect the real recording and connection status
  const [isConnected, setIsConnected] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  
  // ---------------------------------------------------------------------------
  // SETTINGS STATE
  // ---------------------------------------------------------------------------
  // TODO: Wire up to your persistent settings store (e.g., electron-store)
  // These values should be loaded from and saved to persistent storage
  const [settings, setSettings] = useState({
    hotkey: 'Ctrl+Shift+S',        // Activation hotkey combo
    mode: 'hold',                   // 'hold' = hold-to-talk, 'toggle' = press to start/stop
    inputDevice: 'default',         // Audio input device ID
    silenceTimeout: 1.5,            // Seconds of silence before auto-stop
    autoCopy: true,                 // Automatically copy result to clipboard
    autoPaste: false,               // Automatically paste result after transcription
    launchOnBoot: false,            // Start application with system
    startMinimized: false,          // Hide window on launch
    serverUrl: 'http://localhost:8080', // Transcription server URL
  });

  // Tab configuration for the navigation pills
  const tabs = [
    { id: 'history', label: 'History' },
    { id: 'settings', label: 'Settings' },
    { id: 'test', label: 'Test' },
  ];

  // ---------------------------------------------------------------------------
  // DERIVED STATE
  // ---------------------------------------------------------------------------
  // Filter history based on search query (case-insensitive)
  const filteredHistory = mockHistory.filter(item => 
    item.text.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ---------------------------------------------------------------------------
  // HANDLERS
  // ---------------------------------------------------------------------------
  // TODO: Implement these handlers with actual functionality

  /**
   * Copy text to clipboard
   * TODO: Use navigator.clipboard.writeText() or Electron's clipboard API
   */
  const handleCopy = (text) => {
    console.log('Copy:', text);
    // navigator.clipboard.writeText(text);
  };

  /**
   * Delete a transcription from history
   * TODO: Remove from your data store and trigger re-render
   */
  const handleDelete = (id) => {
    console.log('Delete:', id);
  };

  /**
   * Start a test recording
   * TODO: Trigger your audio capture logic
   */
  const handleStartRecording = () => {
    setIsRecording(true);
    // Start audio capture...
  };

  /**
   * Stop the current recording
   * TODO: Stop audio capture and send to transcription server
   */
  const handleStopRecording = () => {
    setIsRecording(false);
    // Stop audio capture, send to server...
  };

  /**
   * Update a setting value
   * TODO: Persist to your settings store
   */
  const updateSetting = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    // Persist to storage...
  };

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  return (
    // Root container - full height, dark background, flex column layout
    // p-2 provides the outermost window padding
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col p-2">
      
      {/* ===================================================================
          HEADER BAR
          Contains navigation pills (left) and status indicators (right)
          px-4 for horizontal padding within the header
          =================================================================== */}
      <header className="h-14 flex items-center justify-between px-4 shrink-0">
        
        {/* Navigation Pills - Segmented control for view switching */}
        <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-full">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveView(tab.id)}
              className={`
                px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200
                ${activeView === tab.id
                  ? 'bg-zinc-100 text-zinc-900'
                  : 'text-zinc-400 hover:text-zinc-200'
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Status Indicators - Recording and connection status */}
        <div className="flex items-center gap-5">
          
          {/* Recording Status Indicator */}
          <div className="flex items-center gap-2">
            <div className={`
              w-2.5 h-2.5 rounded-full transition-colors
              ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-zinc-700'}
            `} />
            <span className="text-xs text-zinc-500">
              {isRecording ? 'Recording' : 'Idle'}
            </span>
          </div>
          
          {/* Connection Status Indicator */}
          <div className="flex items-center gap-2">
            <div className={`
              w-2.5 h-2.5 rounded-full transition-colors
              ${isConnected ? 'bg-emerald-500' : 'bg-amber-500'}
            `} />
            <span className="text-xs text-zinc-500">
              {isConnected ? 'Connected' : 'Offline'}
            </span>
          </div>
        </div>
      </header>

      {/* ===================================================================
          MAIN CONTENT AREA
          Renders the active view (History, Settings, or Test)
          flex-1 takes remaining height, overflow-hidden prevents double scrollbars
          =================================================================== */}
      <main className="flex-1 overflow-hidden">
        
        {/* =================================================================
            HISTORY VIEW
            Browse, search, and manage past transcriptions
            ================================================================= */}
        {activeView === 'history' && (
          <div className="h-full flex flex-col">
            
            {/* Search Bar - px-4 matches header padding */}
            <div className="px-4 pb-4">
              <div className="relative max-w-md">
                {/* Search icon */}
                <svg 
                  className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" 
                  fill="none" 
                  viewBox="0 0 24 24" 
                  stroke="currentColor" 
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search transcriptions..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="
                    w-full bg-zinc-900/80 border border-zinc-800 rounded-full 
                    pl-10 pr-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 
                    focus:outline-none focus:border-zinc-700 focus:bg-zinc-900
                  "
                />
              </div>
            </div>
            
            {/* History List - Scrollable area */}
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {filteredHistory.length === 0 ? (
                // Empty State
                <div className="text-center py-12 text-zinc-500 text-sm">
                  {searchQuery ? 'No matching transcriptions' : 'No transcriptions yet'}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredHistory.map((item) => (
                    <div
                      key={item.id}
                      className={`
                        group rounded-2xl transition-all duration-200
                        ${expandedItem === item.id 
                          ? 'bg-zinc-900 ring-1 ring-zinc-800' 
                          : 'hover:bg-zinc-900/50'
                        }
                      `}
                    >
                      {/* Collapsed/Preview State - Click to expand */}
                      <div
                        className="p-4 cursor-pointer"
                        onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                      >
                        <div className="flex items-start gap-4">
                          <div className="flex-1 min-w-0">
                            {/* Text Preview - Line clamped to 2 lines when collapsed */}
                            <p className={`
                              text-sm text-zinc-200 
                              ${expandedItem === item.id ? '' : 'line-clamp-2'}
                            `}>
                              {item.text}
                            </p>
                            {/* Relative Timestamp */}
                            <p className="text-xs text-zinc-500 mt-1.5">
                              {formatTime(item.timestamp)}
                            </p>
                          </div>
                          
                          {/* Quick Action Buttons - Visible on hover or when expanded */}
                          <div className={`
                            flex items-center gap-1 shrink-0 transition-opacity
                            ${expandedItem === item.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                          `}>
                            {/* Copy Button */}
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleCopy(item.text); }}
                              className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
                              title="Copy"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                              </svg>
                            </button>
                            {/* Delete Button */}
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                              className="p-2 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
                              title="Delete"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                      
                      {/* Expanded Details Panel - Shows full metadata and actions */}
                      {expandedItem === item.id && (
                        <div className="px-4 pb-4 pt-0">
                          <div className="pt-3 border-t border-zinc-800">
                            
                            {/* Metadata Grid - Displays all transcription details */}
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs mb-4">
                              <div>
                                <span className="text-zinc-500">Language</span>
                                <span className="text-zinc-300 ml-2">{item.language.toUpperCase()}</span>
                              </div>
                              <div>
                                <span className="text-zinc-500">Device</span>
                                <span className="text-zinc-300 ml-2">{item.device}</span>
                              </div>
                              <div>
                                <span className="text-zinc-500">Words</span>
                                <span className="text-zinc-300 ml-2">{item.wordCount}</span>
                              </div>
                              <div>
                                <span className="text-zinc-500">Characters</span>
                                <span className="text-zinc-300 ml-2">{item.charCount}</span>
                              </div>
                              <div>
                                <span className="text-zinc-500">Duration</span>
                                <span className="text-zinc-300 ml-2">{item.duration.toFixed(1)}s</span>
                              </div>
                              <div>
                                <span className="text-zinc-500">Speech Rate</span>
                                <span className="text-zinc-300 ml-2">{Math.round(item.wordCount / (item.duration / 60))} WPM</span>
                              </div>
                              <div>
                                <span className="text-zinc-500">Char/sec</span>
                                <span className="text-zinc-300 ml-2">{(item.charCount / item.duration).toFixed(1)}</span>
                              </div>
                              <div className="col-span-2">
                                <span className="text-zinc-500">Timestamp</span>
                                <span className="text-zinc-300 ml-2">{formatFullDate(item.timestamp)}</span>
                              </div>
                            </div>
                            
                            {/* Action Buttons */}
                            <div className="flex gap-2">
                              <button 
                                onClick={() => handleCopy(item.text)}
                                className="px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
                              >
                                Copy Text
                              </button>
                              <button 
                                onClick={() => handleDelete(item.id)}
                                className="px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/50 rounded-lg transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* =================================================================
            SETTINGS VIEW
            Configure application behavior and preferences
            All settings rows span full width with consistent padding
            ================================================================= */}
        {activeView === 'settings' && (
          <div className="h-full overflow-y-auto px-4 pb-4">
            {/* max-w-2xl centers content on wide screens while allowing full width on narrow */}
            <div className="max-w-2xl space-y-8">
              
              {/* ----- ACTIVATION SETTINGS ----- */}
              <SettingsSection title="Activation">
                <SettingsRow 
                  label="Hotkey" 
                  description="Keyboard shortcut to trigger recording"
                >
                  {/* 
                    TODO: Implement hotkey capture dialog
                    When clicked, should open a modal/dialog that captures the next key combination
                  */}
                  <button className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-mono text-zinc-300 transition-colors">
                    {settings.hotkey}
                  </button>
                </SettingsRow>
                
                <SettingsRow 
                  label="Activation Mode" 
                  description="Hold-to-talk or toggle on/off"
                >
                  {/* Segmented control for mode selection */}
                  <div className="flex gap-1 p-1 bg-zinc-800 rounded-lg">
                    <button 
                      onClick={() => updateSetting('mode', 'hold')}
                      className={`
                        px-3 py-1 text-xs rounded-md transition-colors
                        ${settings.mode === 'hold' 
                          ? 'bg-zinc-700 text-zinc-200' 
                          : 'text-zinc-400 hover:text-zinc-300'
                        }
                      `}
                    >
                      Hold
                    </button>
                    <button 
                      onClick={() => updateSetting('mode', 'toggle')}
                      className={`
                        px-3 py-1 text-xs rounded-md transition-colors
                        ${settings.mode === 'toggle' 
                          ? 'bg-zinc-700 text-zinc-200' 
                          : 'text-zinc-400 hover:text-zinc-300'
                        }
                      `}
                    >
                      Toggle
                    </button>
                  </div>
                </SettingsRow>
              </SettingsSection>

              {/* ----- AUDIO SETTINGS ----- */}
              <SettingsSection title="Audio">
                <SettingsRow 
                  label="Input Device" 
                  description="Select microphone for recording"
                >
                  {/* 
                    TODO: Populate with actual system audio devices
                    Use Web Audio API or Electron's desktopCapturer to enumerate devices
                  */}
                  <select 
                    value={settings.inputDevice}
                    onChange={(e) => updateSetting('inputDevice', e.target.value)}
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
                  >
                    <option value="default">Default</option>
                    <option value="device1">Blue Yeti</option>
                    <option value="device2">Headset Mic</option>
                  </select>
                </SettingsRow>
                
                <SettingsRow 
                  label="Silence Timeout" 
                  description="Seconds of silence before auto-stopping"
                >
                  <select 
                    value={settings.silenceTimeout}
                    onChange={(e) => updateSetting('silenceTimeout', parseFloat(e.target.value))}
                    className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 border-none cursor-pointer focus:ring-1 focus:ring-zinc-600"
                  >
                    <option value={1.0}>1.0s</option>
                    <option value={1.5}>1.5s</option>
                    <option value={2.0}>2.0s</option>
                    <option value={3.0}>3.0s</option>
                  </select>
                </SettingsRow>
              </SettingsSection>

              {/* ----- BEHAVIOR SETTINGS ----- */}
              <SettingsSection title="Behavior">
                <SettingsRow 
                  label="Auto-copy" 
                  description="Copy transcription to clipboard automatically"
                >
                  <Toggle 
                    enabled={settings.autoCopy} 
                    onChange={() => updateSetting('autoCopy', !settings.autoCopy)} 
                  />
                </SettingsRow>
                
                <SettingsRow 
                  label="Auto-paste" 
                  description="Paste transcription into active window"
                >
                  <Toggle 
                    enabled={settings.autoPaste} 
                    onChange={() => updateSetting('autoPaste', !settings.autoPaste)} 
                  />
                </SettingsRow>
                
                <SettingsRow 
                  label="Launch on boot" 
                  description="Start application when system starts"
                >
                  <Toggle 
                    enabled={settings.launchOnBoot} 
                    onChange={() => updateSetting('launchOnBoot', !settings.launchOnBoot)} 
                  />
                </SettingsRow>
                
                <SettingsRow 
                  label="Start minimized" 
                  description="Hide main window on application launch"
                >
                  <Toggle 
                    enabled={settings.startMinimized} 
                    onChange={() => updateSetting('startMinimized', !settings.startMinimized)} 
                  />
                </SettingsRow>
              </SettingsSection>

              {/* ----- SERVER SETTINGS ----- */}
              <SettingsSection title="Server">
                {/* Server URL is a special case with a text input spanning full width */}
                <div className="p-4 bg-zinc-900/50 rounded-xl w-full">
                  <label className="text-sm text-zinc-200 block mb-1">
                    Server URL
                  </label>
                  <p className="text-xs text-zinc-500 mb-3">
                    URL of the Whisper transcription server
                  </p>
                  <input
                    type="text"
                    value={settings.serverUrl}
                    onChange={(e) => updateSetting('serverUrl', e.target.value)}
                    className="
                      w-full bg-zinc-800 border border-zinc-700 rounded-lg 
                      px-3 py-2.5 text-sm text-zinc-300 font-mono 
                      focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600
                    "
                    placeholder="http://localhost:8080"
                  />
                </div>
              </SettingsSection>
            </div>
          </div>
        )}

        {/* =================================================================
            TEST VIEW
            Manual transcription testing and debugging
            Useful for testing microphone and server connection
            ================================================================= */}
        {activeView === 'test' && (
          <div className="h-full overflow-y-auto px-4 pb-4">
            <div className="max-w-xl mx-auto">
              
              {/* ----- RECORD BUTTON ----- */}
              {/* Large, centered microphone button for triggering test recordings */}
              <div className="flex flex-col items-center py-12">
                <button
                  onClick={() => isRecording ? handleStopRecording() : handleStartRecording()}
                  className={`
                    w-32 h-32 rounded-full flex items-center justify-center 
                    transition-all duration-300
                    ${isRecording
                      ? 'bg-gradient-to-br from-red-500 to-red-600 shadow-2xl shadow-red-900/40 scale-110'
                      : 'bg-gradient-to-br from-zinc-800 to-zinc-900 hover:from-zinc-700 hover:to-zinc-800 hover:scale-105'
                    }
                  `}
                >
                  {isRecording ? (
                    // Stop icon (rounded square)
                    <div className="w-10 h-10 bg-white rounded-md" />
                  ) : (
                    // Microphone icon
                    <svg className="w-14 h-14 text-zinc-400" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                    </svg>
                  )}
                </button>
                <p className="text-sm text-zinc-500 mt-6">
                  {isRecording ? 'Recording • Click to stop' : 'Click to start recording'}
                </p>
              </div>

              {/* ----- RESULTS SECTION ----- */}
              <div className="space-y-6">
                
                {/* Final Transcription Result */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                      Final Result
                    </h3>
                    {/* TODO: Add copy button here when there's a result */}
                  </div>
                  <div className="p-4 bg-zinc-900/50 rounded-xl min-h-[100px]">
                    {/* 
                      TODO: Display actual transcription result here
                      Replace this placeholder with the final transcribed text
                    */}
                    <p className="text-sm text-zinc-400 italic">
                      Transcription result will appear here...
                    </p>
                  </div>
                </div>

                {/* Partial Results Stream */}
                <div>
                  <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                    Partial Results
                  </h3>
                  <p className="text-xs text-zinc-600 mb-2">
                    Live updates from the streaming transcription protocol
                  </p>
                  <div className="bg-zinc-900/50 rounded-xl overflow-hidden">
                    <div className="p-4 space-y-2 font-mono text-xs max-h-48 overflow-y-auto">
                      {/* 
                        TODO: Map over actual partial results from your streaming protocol
                        
                        Each partial update from the server should be displayed here showing:
                        - Type: [partial] for interim results, [final] for confirmed text
                        - Text: The transcribed text at this point
                        - Processing time: How long this chunk took to process (ms)
                        
                        Example structure:
                        partialResults.map((result, i) => (
                          <div key={i} className="flex gap-3 ...">
                            <span>[{result.type}]</span>
                            <span>"{result.text}"</span>
                            <span>{result.processingTime}ms</span>
                          </div>
                        ))
                      */}
                      <div className="flex gap-3 text-zinc-500">
                        <span className="shrink-0 w-14">[partial]</span>
                        <span className="flex-1">"Hello this is"</span>
                        <span className="text-zinc-600 shrink-0">124ms</span>
                      </div>
                      <div className="flex gap-3 text-zinc-500">
                        <span className="shrink-0 w-14">[partial]</span>
                        <span className="flex-1">"Hello this is a test"</span>
                        <span className="text-zinc-600 shrink-0">89ms</span>
                      </div>
                      <div className="flex gap-3 text-zinc-200">
                        <span className="shrink-0 w-14 text-emerald-500">[final]</span>
                        <span className="flex-1">"Hello, this is a test."</span>
                        <span className="text-zinc-500 shrink-0">156ms</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
