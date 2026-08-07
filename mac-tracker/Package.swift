// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WorkTrackerTracker",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "WorkTrackerTracker",
            path: "Sources/WorkTrackerTracker"
        ),
        .testTarget(
            name: "WorkTrackerTrackerTests",
            dependencies: ["WorkTrackerTracker"],
            path: "Tests/WorkTrackerTrackerTests"
        ),
    ]
)
