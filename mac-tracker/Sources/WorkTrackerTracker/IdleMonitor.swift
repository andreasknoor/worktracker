import CoreGraphics
import Foundation

/// Abstracts "how long since the last keyboard/mouse input", so the polling
/// policy below can be unit tested without touching real system input state.
protocol SystemIdleTimeSource {
    func secondsSinceLastInput() -> TimeInterval
}

/// Real implementation, backed by `CGEventSourceSecondsSinceLastEventType`.
/// Only reads input *timing* — never key content or window titles, matching
/// the "no keylogging" boundary from CONCEPT.md / the Windows tracker.
struct CGEventIdleTimeSource: SystemIdleTimeSource {
    func secondsSinceLastInput() -> TimeInterval {
        // kCGAnyInputEventType (0xFFFFFFFF) isn't bridged as a named Swift
        // constant; constructing it from the raw value is the standard
        // workaround for "any event type" queries.
        let anyInputEventType = CGEventType(rawValue: ~UInt32(0))!
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInputEventType)
    }
}

/// Pure decision: given how long it's been since the last input and how
/// often we poll, was the user active at some point during the last poll
/// interval? If so, "now" gets recorded as an activity event.
///
/// This mirrors the client side of SESSION_LOGIC_SPEC.md: the tracker only
/// ever reports "there was input around this time" — all idle-gap and
/// resume-confirmation logic lives server-side, computed from these raw
/// timestamps.
func shouldRecordActivity(secondsSinceLastInput: TimeInterval, pollInterval: TimeInterval) -> Bool {
    secondsSinceLastInput < pollInterval
}

/// Polls `idleTimeSource` on a repeating timer and invokes `onActive` once
/// per poll tick where `shouldRecordActivity` says the user was active.
final class IdleMonitor {
    private let idleTimeSource: SystemIdleTimeSource
    private let pollInterval: TimeInterval
    private let onActive: () -> Void
    private var timer: Timer?

    init(idleTimeSource: SystemIdleTimeSource, pollInterval: TimeInterval, onActive: @escaping () -> Void) {
        self.idleTimeSource = idleTimeSource
        self.pollInterval = pollInterval
        self.onActive = onActive
    }

    func start() {
        stop()
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        let idleSeconds = idleTimeSource.secondsSinceLastInput()
        if shouldRecordActivity(secondsSinceLastInput: idleSeconds, pollInterval: pollInterval) {
            onActive()
        }
    }
}
