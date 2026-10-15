import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { predictRisk, sendAlert } from '../api';
import { Mic, MicOff, Activity, ChevronDown } from 'lucide-react';

/* ─────────────────────────────────────────────
   Encoding maps  (label → API integer)
───────────────────────────────────────────── */
const ENC = {
    physical_activity_level: { 'Sedentary': 0, 'Light Activity': 1, 'Moderate Activity': 2, 'Active': 3 },
    stress_level: { 'Low': 0, 'Moderate': 1, 'High': 2 },
    fried_food_consumption: { 'Low': 0, 'Moderate': 1, 'High': 2 },
    family_history_heart: { 'No': 0, 'Yes': 1 },
    family_history_diabetes: { 'No': 0, 'Yes': 1 },
    chest_discomfort: { 'Not Applicable': 0, 'Moderate': 1, 'Often': 2 },
    salt_intake_level: { 'Low': 0, 'Moderate': 1, 'High': 2 },
    sugar_intake_level: { 'Low': 0, 'Moderate': 1, 'High': 2 },
    water_intake_liters: { '< 1 Litre': 0.5, '1 - 2 Litres': 1.5, '3 - 4 Litres': 3.5, '> 4 Litres': 4.5 },
    excessive_thirst_fatigue: { 'Low': 0, 'Moderate': 1, 'High': 2 },
    smoking_status: { 'Never': 0, 'Former': 1, 'Current': 2 },
};

/* ─────────────────────────────────────────────
   Validation — fields that must be non-empty
───────────────────────────────────────────── */
// Fields in the form state that must be filled (BMI and WHtR excluded)
const REQUIRED_FIELDS = [
    'age', 'sex', 'height_cm', 'weight_kg', 'waist_cm',
    'physical_activity_level', 'bedtime', 'wakeupTime',
    'stress_level', 'occupation',
    'fried_food_consumption', 'family_history_heart', 'family_history_diabetes',
    'chest_discomfort', 'salt_intake_level', 'sugar_intake_level',
    'water_intake_liters', 'excessive_thirst_fatigue', 'smoking_status',
];

function validate(form) {
    const errors = {};
    REQUIRED_FIELDS.forEach((field) => {
        const val = form[field];
        if (val === undefined || val === null || String(val).trim() === '') {
            errors[field] = 'This field is required';
        }
    });
    return errors;
}

/* ─────────────────────────────────────────────
   Sleep helpers
───────────────────────────────────────────── */
function calcSleepHours(bedtime, wakeupTime) {
    if (!bedtime || !wakeupTime) return null;
    const [bh, bm] = bedtime.split(':').map(Number);
    const [wh, wm] = wakeupTime.split(':').map(Number);
    let bedMins = bh * 60 + bm;
    let wakeMins = wh * 60 + wm;
    if (wakeMins <= bedMins) wakeMins += 24 * 60; // crosses midnight
    return parseFloat(((wakeMins - bedMins) / 60).toFixed(1));
}

/* ─────────────────────────────────────────────
   Shared: voice hook
───────────────────────────────────────────── */
function useMic(onResult) {
    const [listening, setListening] = useState(false);

    const start = useCallback(() => {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            alert('Web Speech API not supported. Please use Chrome or Edge.');
            return;
        }
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new SR();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = 'en-US';
        rec.onstart = () => setListening(true);
        rec.onend = () => setListening(false);
        rec.onerror = () => setListening(false);
        rec.onresult = (e) => {
            const t = e.results[0][0].transcript.trim();
            onResult(t);
            setListening(false);
        };
        rec.start();
    }, [onResult]);

    return { listening, start };
}

/* ─────────────────────────────────────────────
   Mic button (standalone)
───────────────────────────────────────────── */
function MicBtn({ onResult, className = '' }) {
    const { listening, start } = useMic(onResult);
    return (
        <button
            type="button"
            onClick={start}
            title="Click to dictate"
            className={`shrink-0 p-2.5 rounded-xl border transition-all duration-200 cursor-pointer
                  ${listening
                    ? 'border-red-400/60 bg-red-400/10 text-red-400 animate-pulse'
                    : 'border-white/10 bg-white/5 text-gray-400 hover:text-emerald-400 hover:border-emerald-500/40 hover:bg-emerald-500/5'}
                  ${className}`}
        >
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
    );
}

/* ─────────────────────────────────────────────
   Error message (shown below invalid fields)
───────────────────────────────────────────── */
function FieldError({ message }) {
    if (!message) return null;
    return (
        <p style={{ fontSize: '12px', color: '#ef4444', marginTop: '4px' }}>
            {message}
        </p>
    );
}

/* ─────────────────────────────────────────────
   Field wrapper
───────────────────────────────────────────── */
function FieldWrap({ label, hint, children, wide = false }) {
    return (
        <div className={wide ? 'col-span-full sm:col-span-2 lg:col-span-3' : ''}>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
                {label}
                {hint && <span className="ml-1.5 text-xs text-gray-500 font-normal">{hint}</span>}
            </label>
            {children}
        </div>
    );
}

/* ─────────────────────────────────────────────
   Number Input + Mic
───────────────────────────────────────────── */
function NumField({ label, name, value, onChange, placeholder, hint, readOnly, suffix, error, fieldRef }) {
    const handleVoice = useCallback((t) => {
        const m = t.match(/[\d.]+/);
        if (m) onChange({ target: { name, value: m[0] } });
    }, [name, onChange]);

    const borderClass = error
        ? 'border-red-500/80 focus:ring-red-500/50'
        : 'border-white/10 hover:border-white/20 focus:ring-emerald-500/60';

    return (
        <FieldWrap label={label} hint={hint}>
            <div className="flex gap-2 items-center" ref={fieldRef}>
                <div className="relative flex-1">
                    <input
                        type="number"
                        name={name}
                        value={value}
                        onChange={onChange}
                        placeholder={placeholder}
                        readOnly={readOnly}
                        step="any"
                        className={`w-full bg-white/5 border rounded-xl px-4 py-3 text-white placeholder:text-gray-500
                        focus:outline-none focus:ring-2 transition-all pr-14
                        ${readOnly
                                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300 cursor-default'
                                : borderClass}`}
                    />
                    {suffix && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500 pointer-events-none">
                            {suffix}
                        </span>
                    )}
                </div>
                {!readOnly && <MicBtn onResult={handleVoice} />}
            </div>
            <FieldError message={error} />
        </FieldWrap>
    );
}

/* ─────────────────────────────────────────────
   Dropdown + Mic
───────────────────────────────────────────── */
function DropField({ label, name, value, onChange, options, hint, error, fieldRef }) {
    const handleVoice = useCallback((t) => {
        const tl = t.toLowerCase();
        const match = options.find(o => tl.includes(o.toLowerCase()));
        if (match) onChange({ target: { name, value: match } });
    }, [name, onChange, options]);

    const borderClass = error
        ? 'border-red-500/80 focus:ring-red-500/50'
        : 'border-white/10 hover:border-white/20 focus:ring-emerald-500/60';

    return (
        <FieldWrap label={label} hint={hint}>
            <div className="flex gap-2 items-center" ref={fieldRef}>
                <div className="relative flex-1">
                    <select
                        name={name}
                        value={value}
                        onChange={onChange}
                        className={`w-full appearance-none bg-white/5 border rounded-xl px-4 py-3 text-white
                       focus:outline-none focus:ring-2 transition-all cursor-pointer pr-10 ${borderClass}`}
                    >
                        <option value="" disabled className="bg-[#1a1a1a]">Select…</option>
                        {options.map(o => (
                            <option key={o} value={o} className="bg-[#1a1a1a]">{o}</option>
                        ))}
                    </select>
                    <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                </div>
                <MicBtn onResult={handleVoice} />
            </div>
            <FieldError message={error} />
        </FieldWrap>
    );
}

/* ─────────────────────────────────────────────
   Radio Group (Sex)
───────────────────────────────────────────── */
function RadioField({ label, name, value, onChange, options, error, fieldRef }) {
    return (
        <FieldWrap label={label}>
            <div className="flex gap-3" ref={fieldRef}>
                {options.map(opt => (
                    <label key={opt.value}
                        className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl border
                             cursor-pointer transition-all duration-200 font-medium text-sm
                             ${value === opt.value
                                ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                                : error
                                    ? 'border-red-500/80 bg-white/5 text-gray-400 hover:border-red-400 hover:text-white'
                                    : 'border-white/10 bg-white/5 text-gray-400 hover:border-white/20 hover:text-white'}`}
                    >
                        <input
                            type="radio"
                            name={name}
                            value={opt.value}
                            checked={value === opt.value}
                            onChange={onChange}
                            className="sr-only"
                        />
                        <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0
                              ${value === opt.value ? 'border-emerald-400' : 'border-gray-600'}`}>
                            {value === opt.value && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                        </span>
                        {opt.label}
                    </label>
                ))}
            </div>
            <FieldError message={error} />
        </FieldWrap>
    );
}

/* ─────────────────────────────────────────────
   Time Picker + Mic
───────────────────────────────────────────── */
function TimeField({ label, name, value, onChange, error, fieldRef }) {
    const handleVoice = useCallback((t) => {
        // parse "10 30 PM" or "ten thirty pm" → 22:30
        const m12 = t.match(/(\d{1,2})[\s:h](\d{0,2})?\s*(am|pm)/i);
        if (m12) {
            let h = parseInt(m12[1]);
            const mn = parseInt(m12[2] || '0');
            const ampm = m12[3].toLowerCase();
            if (ampm === 'pm' && h !== 12) h += 12;
            if (ampm === 'am' && h === 12) h = 0;
            onChange({ target: { name, value: `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}` } });
        }
    }, [name, onChange]);

    const borderClass = error
        ? 'border-red-500/80 focus:ring-red-500/50'
        : 'border-white/10 hover:border-white/20 focus:ring-emerald-500/60';

    return (
        <FieldWrap label={label}>
            <div className="flex gap-2 items-center" ref={fieldRef}>
                <input
                    type="time"
                    name={name}
                    value={value}
                    onChange={onChange}
                    className={`flex-1 bg-white/5 border rounded-xl px-4 py-3
                     text-white focus:outline-none focus:ring-2 transition-all
                     [color-scheme:dark] ${borderClass}`}
                />
                <MicBtn onResult={handleVoice} />
            </div>
            <FieldError message={error} />
        </FieldWrap>
    );
}

/* ─────────────────────────────────────────────
   Section header
───────────────────────────────────────────── */
function Section({ icon, title, subtitle }) {
    return (
        <div className="col-span-full flex items-center gap-3 pt-2 pb-1 border-b border-white/5">
            <span className="text-emerald-400">{icon}</span>
            <div>
                <p className="font-semibold text-white/90 text-sm">{title}</p>
                {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
            </div>
        </div>
    );
}

/* ─────────────────────────────────────────────
   Main Component
───────────────────────────────────────────── */
const INITIAL = {
    age: '', sex: '',
    height_cm: '', weight_kg: '', waist_cm: '', BMI: '',
    physical_activity_level: '', bedtime: '', wakeupTime: '',
    stress_level: '', occupation: '',
    family_history_heart: '', family_history_diabetes: '',
    smoking_status: '', fried_food_consumption: '', chest_discomfort: '',
    salt_intake_level: '', sugar_intake_level: '', water_intake_liters: '', excessive_thirst_fatigue: '',
};

const InputForm = () => {
    const [form, setForm] = useState(INITIAL);
    const [sleepHours, setSleepHours] = useState(null);
    const [WHtR, setWHtR] = useState('');
    const [loading, setLoading] = useState(false);
    const [errors, setErrors] = useState({});
    const [showSummaryError, setShowSummaryError] = useState(false);
    const navigate = useNavigate();

    // Refs map for auto-scroll to first invalid field
    const fieldRefs = useRef({});
    const summaryRef = useRef(null);

    /* Auto-calc BMI */
    useEffect(() => {
        const h = parseFloat(form.height_cm);
        const w = parseFloat(form.weight_kg);
        if (h > 0 && w > 0) {
            const bmi = (w / Math.pow(h / 100, 2)).toFixed(1);
            setForm(prev => ({ ...prev, BMI: bmi }));
        } else {
            setForm(prev => ({ ...prev, BMI: '' }));
        }
    }, [form.height_cm, form.weight_kg]);

    /* Auto-calc WHtR = waist_cm / height_cm */
    useEffect(() => {
        const waist = parseFloat(form.waist_cm);
        const height = parseFloat(form.height_cm);
        if (waist > 0 && height > 0) {
            setWHtR((waist / height).toFixed(3));
        } else {
            setWHtR('');
        }
    }, [form.waist_cm, form.height_cm]);

    /* Auto-calc sleep hours */
    useEffect(() => {
        setSleepHours(calcSleepHours(form.bedtime, form.wakeupTime));
    }, [form.bedtime, form.wakeupTime]);

    /* Real-time error clearing on change */
    const handleChange = useCallback((e) => {
        const { name, value } = e.target;
        setForm(prev => ({ ...prev, [name]: value }));
        // Clear error for this field as soon as user interacts
        if (errors[name]) {
            setErrors(prev => {
                const next = { ...prev };
                delete next[name];
                return next;
            });
        }
    }, [errors]);

    const handleSubmit = async (e) => {
        e.preventDefault();

        // ── Validate all required fields ──
        const newErrors = validate(form);
        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            setShowSummaryError(true);

            // Scroll to summary banner first, then first invalid field
            if (summaryRef.current) {
                summaryRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            // After a short delay, scroll to first invalid field
            setTimeout(() => {
                const firstField = REQUIRED_FIELDS.find(f => newErrors[f]);
                if (firstField && fieldRefs.current[firstField]) {
                    fieldRefs.current[firstField].scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 350);

            return; // Do NOT call API
        }

        // All valid — clear errors and proceed
        setErrors({});
        setShowSummaryError(false);
        setLoading(true);

        try {
            // Build the payload, encoding labels → numbers
            const payload = {
                age: parseFloat(form.age) || 0,
                sex: form.sex === 'male' ? 1 : 0,
                height_cm: parseFloat(form.height_cm) || 0,
                weight_kg: parseFloat(form.weight_kg) || 0,
                waist_cm: parseFloat(form.waist_cm) || 0,
                physical_activity_level: ENC.physical_activity_level[form.physical_activity_level] ?? 0,
                sleep_hours: sleepHours ?? 0,
                stress_level: ENC.stress_level[form.stress_level] ?? 0,
                family_history_heart: ENC.family_history_heart[form.family_history_heart] ?? 0,
                family_history_diabetes: ENC.family_history_diabetes[form.family_history_diabetes] ?? 0,
                smoking_status: ENC.smoking_status[form.smoking_status] ?? 0,
                fried_food_consumption: ENC.fried_food_consumption[form.fried_food_consumption] ?? 0,
                chest_discomfort: ENC.chest_discomfort[form.chest_discomfort] ?? 0,
                salt_intake_level: ENC.salt_intake_level[form.salt_intake_level] ?? 0,
                sugar_intake_level: ENC.sugar_intake_level[form.sugar_intake_level] ?? 0,
                water_intake_liters: ENC.water_intake_liters[form.water_intake_liters] ?? 0.5,
                excessive_thirst_fatigue: ENC.excessive_thirst_fatigue[form.excessive_thirst_fatigue] ?? 0,
            };

            const data = await predictRisk(payload);

            // Save results to sessionStorage
            sessionStorage.setItem('vitalResults', JSON.stringify(data));

            // Auto-send alert if any risk is high
            if (data.heart_risk_percent > 70 ||
                data.diabetes_risk_percent > 70 ||
                data.obesity_risk_percent > 70) {
                // Try to send alert (user may not have set family emails)
                try {
                    await sendAlert(
                        "User",
                        data.heart_risk_percent,
                        data.diabetes_risk_percent,
                        data.obesity_risk_percent || 0
                    )
                } catch (e) {
                    console.log("Alert notification not sent:", e)
                }
            }

            navigate('/results', { state: { results: data, originalData: payload } });
        } catch (err) {
            console.error(err);
            const errorMsg = err.message || 'Failed to submit prediction';
            if (errorMsg.includes('Cannot connect')) {
                alert('Cannot connect to server. Make sure backend is running on localhost:8000 and execute: python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload');
            } else if (errorMsg.includes('Invalid input')) {
                alert('Invalid input data. Please check your form values.');
            } else if (errorMsg.includes('Prediction failed')) {
                alert('Prediction failed. Please check your inputs.');
            } else {
                alert('Something went wrong. ' + errorMsg);
            }
        } finally {
            setLoading(false);
        }
    };

    // Helper to attach a ref to a field's container
    const ref = (name) => (el) => { fieldRefs.current[name] = el; };

    /* ── Section icons (inline SVG, no extra dep) ── */
    const icons = {
        basics: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>,
        vitals: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>,
        lifestyle: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>,
        health: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg>,
        diet: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1" /><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8Z" /><line x1="6" y1="1" x2="6" y2="4" /><line x1="10" y1="1" x2="10" y2="4" /><line x1="14" y1="1" x2="14" y2="4" /></svg>,
    };

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-white">
            <div className="max-w-4xl mx-auto px-4 pt-10 pb-28">

                {/* ── Header card ── */}
                <div className="relative bg-white/[0.03] border border-white/[0.08] rounded-2xl p-8 mb-8 overflow-hidden">
                    <div className="absolute top-0 right-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />
                    <div className="flex items-center gap-4 relative">
                        <div className="w-12 h-12 bg-emerald-500/20 border border-emerald-500/30 rounded-xl flex items-center justify-center shrink-0">
                            <Activity className="text-emerald-400" size={24} />
                        </div>
                        <div>
                            <h1 className="text-2xl md:text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-teal-300">
                                Health Risk Assessment
                            </h1>
                            <p className="text-gray-400 text-sm mt-0.5">
                                Fill in your details below — mic icon on each field for voice input
                            </p>
                        </div>
                    </div>
                </div>

                {/* ── Summary error banner ── */}
                {showSummaryError && (
                    <div
                        ref={summaryRef}
                        style={{ color: '#ef4444' }}
                        className="mb-6 bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-3 text-center font-bold text-sm"
                    >
                        ⚠ Please fill all required fields before evaluating.
                    </div>
                )}

                {/* ── Form card ── */}
                <form onSubmit={handleSubmit}
                    className="bg-white/[0.03] border border-white/[0.08] rounded-2xl p-6 md:p-8">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-7">

                        {/* ──── SECTION: BASICS ──── */}
                        <Section icon={icons.basics} title="Personal Details" />

                        <NumField
                            label="Age" name="age" value={form.age} onChange={handleChange}
                            placeholder="e.g. 25" suffix="yrs"
                            error={errors.age} fieldRef={ref('age')}
                        />

                        <RadioField
                            label="Sex" name="sex" value={form.sex} onChange={handleChange}
                            options={[{ label: 'Male', value: 'male' }, { label: 'Female', value: 'female' }]}
                            error={errors.sex} fieldRef={ref('sex')}
                        />

                        {/* ──── SECTION: VITALS ──── */}
                        <Section icon={icons.vitals} title="Body Vitals" />

                        <NumField
                            label="Height" name="height_cm" value={form.height_cm} onChange={handleChange}
                            placeholder="e.g. 170" suffix="cm"
                            error={errors.height_cm} fieldRef={ref('height_cm')}
                        />
                        <NumField
                            label="Weight" name="weight_kg" value={form.weight_kg} onChange={handleChange}
                            placeholder="e.g. 68" suffix="kg"
                            error={errors.weight_kg} fieldRef={ref('weight_kg')}
                        />
                        <NumField
                            label="Waist" name="waist_cm" value={form.waist_cm} onChange={handleChange}
                            placeholder="e.g. 80" suffix="cm"
                            error={errors.waist_cm} fieldRef={ref('waist_cm')}
                        />

                        {/* BMI — read-only, auto-calculated */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1.5">
                                BMI
                                <span className="ml-1.5 text-xs text-gray-500 font-normal">auto-calculated</span>
                            </label>
                            <div className="relative">
                                <input
                                    type="text"
                                    readOnly
                                    value={form.BMI ? `${form.BMI}` : ''}
                                    placeholder="Fill height & weight"
                                    className="w-full bg-emerald-500/5 border border-emerald-500/25 rounded-xl px-4 py-3
                             text-emerald-300 placeholder:text-gray-600 focus:outline-none cursor-default"
                                />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-600 pointer-events-none">
                                    kg/m²
                                </span>
                            </div>
                            {form.BMI && (
                                <p className="text-xs mt-1.5 text-gray-500">
                                    {parseFloat(form.BMI) < 18.5 ? '⚠ Underweight'
                                        : parseFloat(form.BMI) < 25 ? '✓ Normal'
                                            : parseFloat(form.BMI) < 30 ? '⚠ Overweight'
                                                : '⚠ Obese'}
                                </p>
                            )}
                        </div>

                        {/* WHtR — read-only, auto-calculated */}
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1.5">
                                WHtR
                                <span className="ml-1.5 text-xs text-gray-500 font-normal">auto-calculated</span>
                            </label>
                            <div className="relative">
                                <input
                                    type="text"
                                    readOnly
                                    value={WHtR}
                                    placeholder="Fill waist & height"
                                    className="w-full bg-emerald-500/5 border border-emerald-500/25 rounded-xl px-4 py-3
                             text-emerald-300 placeholder:text-gray-600 focus:outline-none cursor-default"
                                />
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-600 pointer-events-none">
                                    ratio
                                </span>
                            </div>
                            {WHtR && (() => {
                                const v = parseFloat(WHtR);
                                const [icon, colour, label] =
                                    v < 0.40 ? ['●', 'text-blue-400', 'Underweight Risk'] :
                                        v < 0.50 ? ['✓', 'text-emerald-400', 'Healthy'] :
                                            v < 0.60 ? ['⚠', 'text-yellow-400', 'Overweight Risk'] :
                                                ['⚠', 'text-red-400', 'High Obesity Risk'];
                                return (
                                    <p className={`text-xs mt-1.5 font-medium ${colour}`}>
                                        {icon} {label}
                                    </p>
                                );
                            })()}
                        </div>

                        {/* ──── SECTION: LIFESTYLE ──── */}
                        <Section icon={icons.lifestyle} title="Lifestyle" />

                        <DropField
                            label="Physical Activity Level" name="physical_activity_level"
                            value={form.physical_activity_level} onChange={handleChange}
                            options={['Sedentary', 'Light Activity', 'Moderate Activity', 'Active']}
                            error={errors.physical_activity_level} fieldRef={ref('physical_activity_level')}
                        />

                        {/* Sleep — bedtime + wakeup */}
                        <div className="col-span-full sm:col-span-2 lg:col-span-2">
                            <label className="block text-sm font-medium text-gray-300 mb-1.5">Sleep Schedule</label>
                            <div className="grid grid-cols-2 gap-3">
                                <TimeField
                                    label="Bedtime" name="bedtime" value={form.bedtime} onChange={handleChange}
                                    error={errors.bedtime} fieldRef={ref('bedtime')}
                                />
                                <TimeField
                                    label="Wake-up time" name="wakeupTime" value={form.wakeupTime} onChange={handleChange}
                                    error={errors.wakeupTime} fieldRef={ref('wakeupTime')}
                                />
                            </div>
                            {sleepHours !== null && (
                                <p className="mt-2 text-sm text-emerald-400 font-medium">
                                    🌙 Sleep duration: <strong>{sleepHours} hours</strong>
                                    <span className="ml-2 text-xs text-gray-500">
                                        {sleepHours < 6 ? '(Too little)' : sleepHours <= 9 ? '(Healthy range)' : '(Excessive)'}
                                    </span>
                                </p>
                            )}
                        </div>

                        <DropField
                            label="Stress Level" name="stress_level"
                            value={form.stress_level} onChange={handleChange}
                            options={['Low', 'Moderate', 'High']}
                            error={errors.stress_level} fieldRef={ref('stress_level')}
                        />

                        {/* Occupation — display only, not sent to API */}
                        <FieldWrap label="Occupation / Work Type" hint="display only">
                            <div className="flex gap-2 items-center" ref={ref('occupation')}>
                                <input
                                    type="text"
                                    name="occupation"
                                    value={form.occupation}
                                    onChange={handleChange}
                                    placeholder="e.g. Student, Office Job, Physical Labor"
                                    className={`flex-1 bg-white/5 border rounded-xl
                             px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none
                             focus:ring-2 transition-all ${errors.occupation
                                            ? 'border-red-500/80 focus:ring-red-500/50'
                                            : 'border-white/10 hover:border-white/20 focus:ring-emerald-500/60'}`}
                                />
                                <MicBtn onResult={(t) => handleChange({ target: { name: 'occupation', value: t } })} />
                            </div>
                            <FieldError message={errors.occupation} />
                        </FieldWrap>

                        <DropField
                            label="Smoking Status" name="smoking_status"
                            value={form.smoking_status} onChange={handleChange}
                            options={['Never', 'Former', 'Current']}
                            error={errors.smoking_status} fieldRef={ref('smoking_status')}
                        />

                        {/* ──── SECTION: HEALTH HISTORY ──── */}
                        <Section icon={icons.health} title="Health & Family History" />

                        <DropField
                            label="Family History — Heart Disease" name="family_history_heart"
                            value={form.family_history_heart} onChange={handleChange}
                            options={['No', 'Yes']}
                            error={errors.family_history_heart} fieldRef={ref('family_history_heart')}
                        />
                        <DropField
                            label="Family History — Diabetes" name="family_history_diabetes"
                            value={form.family_history_diabetes} onChange={handleChange}
                            options={['No', 'Yes']}
                            error={errors.family_history_diabetes} fieldRef={ref('family_history_diabetes')}
                        />
                        <DropField
                            label="Chest Discomfort" name="chest_discomfort"
                            value={form.chest_discomfort} onChange={handleChange}
                            options={['Not Applicable', 'Moderate', 'Often']}
                            error={errors.chest_discomfort} fieldRef={ref('chest_discomfort')}
                        />
                        <DropField
                            label="Thirst Level" name="excessive_thirst_fatigue"
                            value={form.excessive_thirst_fatigue} onChange={handleChange}
                            options={['Low', 'Moderate', 'High']}
                            error={errors.excessive_thirst_fatigue} fieldRef={ref('excessive_thirst_fatigue')}
                        />

                        {/* ──── SECTION: DIET ──── */}
                        <Section icon={icons.diet} title="Diet & Nutrition" />

                        <DropField
                            label="Junk Food Consumption" name="fried_food_consumption"
                            value={form.fried_food_consumption} onChange={handleChange}
                            options={['Low', 'Moderate', 'High']}
                            error={errors.fried_food_consumption} fieldRef={ref('fried_food_consumption')}
                        />
                        <DropField
                            label="Salt Intake" name="salt_intake_level"
                            value={form.salt_intake_level} onChange={handleChange}
                            options={['Low', 'Moderate', 'High']}
                            error={errors.salt_intake_level} fieldRef={ref('salt_intake_level')}
                        />
                        <DropField
                            label="Sugar Intake" name="sugar_intake_level"
                            value={form.sugar_intake_level} onChange={handleChange}
                            options={['Low', 'Moderate', 'High']}
                            error={errors.sugar_intake_level} fieldRef={ref('sugar_intake_level')}
                        />
                        <DropField
                            label="Daily Water Intake" name="water_intake_liters"
                            value={form.water_intake_liters} onChange={handleChange}
                            options={['< 1 Litre', '1 - 2 Litres', '3 - 4 Litres', '> 4 Litres']}
                            error={errors.water_intake_liters} fieldRef={ref('water_intake_liters')}
                        />

                    </div>{/* end grid */}

                    {/* ── Submit ── */}
                    <div className="mt-10">
                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-4 rounded-xl font-bold text-lg text-black
                         bg-gradient-to-r from-emerald-500 to-teal-500
                         hover:from-emerald-400 hover:to-teal-400
                         disabled:opacity-60 disabled:cursor-not-allowed
                         transition-all duration-200 hover:scale-[1.01] active:scale-[0.99]
                         shadow-xl shadow-emerald-500/25"
                        >
                            {loading
                                ? <span className="flex items-center justify-center gap-2"><SpinIcon />Analyzing Models…</span>
                                : '⚡ Evaluate Risk'}
                        </button>
                    </div>
                </form>
            </div>

            {/* Sticky disclaimer */}
            <p className="fixed bottom-0 left-0 right-0 bg-[#0a0a0a]/90 backdrop-blur-sm
                    border-t border-white/5 text-center text-gray-600 text-xs py-3">
                * Educational only. Not a medical diagnosis. Consult a doctor.
            </p>
        </div>
    );
};

export default InputForm;

function SpinIcon() {
    return (
        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
    );
}
