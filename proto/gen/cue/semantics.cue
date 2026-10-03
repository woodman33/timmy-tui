package spacev1

import (
	"encoding/base64"
	"list"
	"math"
)

// Imported protobuf definitions remain authoritative for shape and enum names.
// The JSON adapter decodes bytes before unification with imported CUE types.
#Revision: string & !=""
#IdentityContract: #Identity & {id: #Revision, sourceRevision: #Revision, frameId: #Revision}
#BasisContract: #Basis & {
	x: #Vec3 & {x: number, y: number, z: number}
	y: #Vec3 & {x: number, y: number, z: number}
	z: #Vec3 & {x: number, y: number, z: number}
	_xx:          x.x*x.x + x.y*x.y + x.z*x.z
	_yy:          y.x*y.x + y.y*y.y + y.z*y.z
	_zz:          z.x*z.x + z.y*z.y + z.z*z.z
	_xy:          x.x*y.x + x.y*y.y + x.z*y.z
	_xz:          x.x*z.x + x.y*z.y + x.z*z.z
	_yz:          y.x*z.x + y.y*z.y + y.z*z.z
	_det:         x.x*(y.y*z.z-y.z*z.y) - x.y*(y.x*z.z-y.z*z.x) + x.z*(y.x*z.y-y.y*z.x)
	_unitX:       true & (math.Abs(_xx-1) <= 0.000000001)
	_unitY:       true & (math.Abs(_yy-1) <= 0.000000001)
	_unitZ:       true & (math.Abs(_zz-1) <= 0.000000001)
	_orthXY:      true & (math.Abs(_xy) <= 0.000000001)
	_orthXZ:      true & (math.Abs(_xz) <= 0.000000001)
	_orthYZ:      true & (math.Abs(_yz) <= 0.000000001)
	_rightHanded: true & (math.Abs(_det-1) <= 0.000000001)
}
#FrameContract: #Frame & {
	identity: #IdentityContract
	units:    "UNITS_MM" | "UNITS_CM" | "UNITS_M"
	origin: #Vec3 & {x: number, y: number, z: number}
	basis: #BasisContract
}
#HeaderContract: #VoxelHeader & {
	schema:         "timmy.space.voxel/1"
	sourceRevision: #Revision
	frameId:        #Revision
	units:          "UNITS_MM" | "UNITS_CM" | "UNITS_M"
	voxelSize:      number & >0
	origin: #Vec3 & {x: number, y: number, z: number}
	basis:              #BasisContract
	channelSchemaHash:  bytes
	_channelHashLength: true & (len(channelSchemaHash) == 32)
	topologyLog2: [5, 4, 3]
	channels: [...#ChannelDeclaration & {
		kind:       #ChannelKind
		storage:    #Revision
		components: int & >=1 & <=3
		unit:       #Revision
		quantization: #Quantization & {
			scale:    number & >0
			clampMin: number
			clampMax: number & >=clampMin
			rounding: "round_half_even"
			owner:    "rust"
		}
		if kind == "CHANNEL_KIND_SIGMA" {
			storage:    "u16"
			components: 1
			unit:       "um"
			statistic:  "1sigma"
		}
	}]
}
#LeafContract: #VoxelLeaf & {
	origin: #Int3 & {x: int32, y: int32, z: int32}
	metadata: #LeafMetadata & {
		provenance:        "PROVENANCE_MEASURED" | "PROVENANCE_RECONSTRUCTED_SCALE_UNCHECKED" | "PROVENANCE_GENERATED"
		evidenceState:     "EVIDENCE_STATE_DECLARED" | "EVIDENCE_STATE_CONSTRUCTED" | "EVIDENCE_STATE_CHECKED" | "EVIDENCE_STATE_INFERRED" | "EVIDENCE_STATE_STALE"
		observationCount:  int & >=0 & <=65535
		sourceSetHash:     bytes
		_sourceHashLength: true & (len(sourceSetHash) == 32)
	}
	channelOrder: [...#ChannelKind]
	state: {values: [for _ in list.Range(0, 512, 1) {int & >=0 & <=2}]}
	tsdf: {values: [for _ in list.Range(0, 512, 1) {int & >=-32768 & <=32767}]}
	weight: {values: [for _ in list.Range(0, 512, 1) {int & >=0 & <=65535}]}
	rgb?: {values: [for _ in list.Range(0, 512, 1) {{r: int & >=0 & <=255, g: int & >=0 & <=255, b: int & >=0 & <=255}}]}
	instanceLabel?: {values: [for _ in list.Range(0, 512, 1) {int & >=0 & <=4294967295}]}
	fill?: {values: [for _ in list.Range(0, 512, 1) {int & >=0 & <=65535}]}
	normal?: {values: [for _ in list.Range(0, 512, 1) {{x: int & >=-128 & <=127, y: int & >=-128 & <=127, z: int & >=-128 & <=127}}]}
	featureRef?: {values: [for _ in list.Range(0, 512, 1) {int & >=0 & <=4294967295}]}
	sigma?: {values: [for _ in list.Range(0, 512, 1) {int & >=0 & <=65535}]}
	_stateRules: [for i, w in weight.values {true & ((w != 0 || state.values[i] == 0) && (state.values[i] != 1 || (w > 0 && tsdf.values[i] > 0)))}]

}
#RegionContract: #VoxelRegion & {
	identity:  #IdentityContract
	allocated: bool
	state:     #VoxelState
	if !allocated {state: "VOXEL_STATE_UNKNOWN"}
}
#JobContract: #Job & {
	schema:           "timmy.job/2"
	jobId:            #Revision
	operationId:      #Revision
	sourceRevision:   #Revision
	documentRevision: #Revision
	requestId:        #Revision
	state:            #JobState & !="JOB_STATE_UNSPECIFIED"
	progress:         number & >=0 & <=1
	createdAt:        #Revision
	updatedAt:        #Revision
	recovery?: #Recovery & {
		replaySafe: bool
		if replaySafe {
			verifiedComplete:  true
			readbackReference: #Revision
		}
	}
}
#CapabilityContract: #Capability & {
	verb: #Revision
	rung: #CapabilityRung & !="CAPABILITY_RUNG_UNSPECIFIED"
	license: #License & {tier: #LicenseTier & !="LICENSE_TIER_UNSPECIFIED", sources: [...#Revision]}
	publicEligible: bool
	if publicEligible {license: tier: "LICENSE_TIER_COMMERCIAL"}
	if rung == "CAPABILITY_RUNG_QUALIFIED" || rung == "CAPABILITY_RUNG_DEPLOYED" {
		observedAt: #Revision
		supportingReferences: [#EvidenceReference, ...#EvidenceReference]
	}
}
#DimensionContract: #Dimension & {
	valueMm:     number & >=0
	plusMinusMm: number & >=0
	budget: #UncertaintyBudget & {
		fiducialScaleMm:       number & >=0
		calibrationResidualMm: number & >=0
		edgeLocalizationMm:    number & >=0
		sensorFloorMm:         number & >=0
	}
	instrument: #Revision
	measured:   false // Qualification requires a later, independently approved benchmark.
	caliperMm?: number
	if caliperMm != _|_ {
		caliperMm: number & >=(valueMm - plusMinusMm) & <=(valueMm + plusMinusMm)
	}
}

// Fixture JSON uses standard protobuf JSON (base64 strings for byte fields).
input: {
	header:  _
	leaf:    _
	region:  _
	frame:   _
	jobs:    _
	receipt: _
	...
}
validated: #ContractFixture & {
	for k, v in input if k != "header" && k != "leaf" && k != "receipt" {"\(k)": v}
	frame:  #FrameContract
	region: #RegionContract
	jobs: [...#JobContract]
	header: #HeaderContract & {
		for k, v in input.header if k != "channelSchemaHash" {"\(k)": v}
		channelSchemaHash: base64.Decode(null, input.header.channelSchemaHash)
	}
	leaf: #LeafContract & {
		for k, v in input.leaf if k != "metadata" {"\(k)": v}
		metadata: {
			for k, v in input.leaf.metadata if k != "sourceSetHash" {"\(k)": v}
			sourceSetHash: base64.Decode(null, input.leaf.metadata.sourceSetHash)
		}
	}
	receipt: {
		for k, v in input.receipt if k != "canonicalJson" && k != "signature" {"\(k)": v}
		canonicalJson: base64.Decode(null, input.receipt.canonicalJson)
		signature:     base64.Decode(null, input.receipt.signature)
	}
	if input.capability != _|_ {capability: #CapabilityContract}
	if input.dimension != _|_ {dimension: #DimensionContract}
	_order: true & (leaf.channelOrder == [for d in header.channels {d.kind}])
	_uniqueChannels: true & list.UniqueItems(leaf.channelOrder)
}
