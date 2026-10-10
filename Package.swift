// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "recap",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "recap", targets: ["recap"]),
        .executable(name: "recap-capture", targets: ["recap-capture"]),
        .library(name: "RecapCapture", targets: ["RecapCapture"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0")
    ],
    targets: [
        .target(
            name: "RecapCapture",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "recap",
            dependencies: [
                "RecapCapture",
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "recap-capture",
            dependencies: [
                "RecapCapture",
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "recapTests",
            dependencies: ["recap", "RecapCapture"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "RecapCaptureTests",
            dependencies: [
                "RecapCapture",
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
