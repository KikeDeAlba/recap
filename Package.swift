// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "recap",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "recap", targets: ["recap"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0")
    ],
    targets: [
        .executableTarget(
            name: "recap",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "recapTests",
            dependencies: ["recap"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
